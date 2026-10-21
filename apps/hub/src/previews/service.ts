import { randomBytes } from 'node:crypto';
import type { Preview } from '@mowbot/contract';
import { and, eq } from 'drizzle-orm';
import { type AgentClient, TunnelRefusedError } from '../computers/agent-client';
import { AGENT_PORT } from '../computers/runtime';
import type { ComputerService, Logger } from '../computers/service';
import type { PortRange } from '../config';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { previews } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { createPreviewServer, type PreviewServer, type PreviewTarget, TOKEN_PARAM } from './proxy';

export type PreviewRow = typeof previews.$inferSelect;

const TOKEN_PURPOSE = 'preview-token';

/** The PC's own services: never shown as a preview (mow-agent refuses them too). */
const RESERVED_PORTS = new Set([AGENT_PORT, 5900, 9222]);
const isReserved = (port: number) => RESERVED_PORTS.has(port) || (port >= 6000 && port < 6064);

/** How the user's apps reach the hub: links are built on that address. */
export interface LinkBase {
  protocol: 'http' | 'https';
  hostname: string;
}

export interface PreviewServiceOptions {
  ports: PortRange | null;
  publicUrl: string | undefined;
  ttlMs: number;
  /** Interface the preview ports listen on (the hub's). */
  host: string;
  trustProxy: boolean;
  /** Replaced in tests. */
  now?: () => number;
}

interface Active {
  row: PreviewRow;
  target: PreviewTarget;
  server: PreviewServer;
}

const silentLogger: Logger = { warn: () => {}, error: () => {} };

/** `[::1]` stays bracketed in a URL; `::1` gets brackets. */
const urlHost = (hostname: string) =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;

/**
 * Previews: a dev server on a bot's PC, served on one of the hub's ports (same address as the
 * hub, so its certificate works and the page's absolute paths and WebSockets too). A preview
 * lasts until it is stopped, its PC stops or sleeps, or `ttlMs` passes.
 */
export class PreviewService {
  private log: Logger = silentLogger;
  private readonly active = new Map<number, Active>();
  private readonly agents = new Map<string, Promise<AgentClient>>();
  private lastSeen: LinkBase | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly computers: ComputerService,
    private readonly events: EventBus,
    private readonly masterKey: Buffer,
    private readonly options: PreviewServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    // A PC that stops or sleeps takes its previews with it.
    this.unsubscribe = events.subscribe((event) => {
      if (event.type !== 'computer.updated') return;
      const { id, status } = event.computer;
      if (status === 'stopping' || status === 'stopped' || status === 'error') {
        this.agents.delete(id);
        if ([...this.active.values()].some((a) => a.row.computerId === id)) {
          this.endComputer(id).catch((error) =>
            this.log.error({ err: error, computerId: id }, 'Could not end previews'),
          );
        }
      }
    });
  }

  setLogger(log: Logger): void {
    this.log = log;
  }

  get enabled(): boolean {
    return this.options.ports !== null;
  }

  /** Called on the owner's authenticated requests: bots' links point where the apps are. */
  seen(protocol: string, hostname: string): void {
    if (!hostname) return;
    this.lastSeen = { protocol: protocol === 'https' ? 'https' : 'http', hostname };
  }

  /** Where links given to bots point: MOWBOT_PUBLIC_URL, else the apps' latest address. */
  linkBase(): LinkBase {
    if (this.options.publicUrl) {
      const url = new URL(this.options.publicUrl);
      return { protocol: url.protocol === 'https:' ? 'https' : 'http', hostname: url.hostname };
    }
    return this.lastSeen ?? { protocol: 'http', hostname: 'localhost' };
  }

  url(row: PreviewRow, token: string, base: LinkBase): string {
    const separator = row.path.includes('?') ? '&' : '?';
    return `${base.protocol}://${urlHost(base.hostname)}:${row.publicPort}${row.path}${separator}${TOKEN_PARAM}=${token}`;
  }

  tokenOf(row: PreviewRow): string {
    return open(this.masterKey, TOKEN_PURPOSE, row.tokenSealed);
  }

  toPreview(row: PreviewRow, base: LinkBase): Preview {
    return {
      id: row.id,
      computerId: row.computerId,
      botId: row.botId,
      title: row.title,
      port: row.port,
      publicPort: row.publicPort,
      path: row.path,
      url: this.url(row, this.tokenOf(row), base),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Previews still running, oldest first. */
  async list(computerId?: string): Promise<PreviewRow[]> {
    const now = this.now();
    const rows = await this.db
      .select()
      .from(previews)
      .where(computerId ? eq(previews.computerId, computerId) : undefined)
      .orderBy(previews.createdAt);
    return rows.filter((row) => row.expiresAt.getTime() > now && this.active.has(row.publicPort));
  }

  /**
   * Shares the dev server listening on `port` of the PC. Sharing a port again keeps its link
   * and restarts its clock.
   */
  async share(input: {
    computerId: string;
    botId: string | null;
    port: number;
    title: string;
    path: string;
  }): Promise<{ row: PreviewRow; token: string; created: boolean }> {
    const range = this.options.ports;
    if (!range) {
      throw new HttpProblem(
        503,
        'previews_off',
        'Previews are turned off on this hub (MOWBOT_PREVIEW_PORTS=off).',
      );
    }
    if (isReserved(input.port)) {
      throw new HttpProblem(
        400,
        'preview_port_reserved',
        `Port ${input.port} is one of the PC's own services, not a web page.`,
      );
    }
    const computer = await this.computers.get(input.computerId);
    if (computer.kind === 'mcp') {
      throw new HttpProblem(400, 'preview_not_allowed', 'The MCP computer has no previews.');
    }
    await this.probe(input.computerId, input.port);
    const expiresAt = new Date(this.now() + this.options.ttlMs);

    const [existing] = await this.db
      .select()
      .from(previews)
      .where(and(eq(previews.computerId, input.computerId), eq(previews.port, input.port)));
    if (existing && this.active.has(existing.publicPort)) {
      const [row] = await this.db
        .update(previews)
        .set({ title: input.title, path: input.path, botId: input.botId, expiresAt })
        .where(eq(previews.id, existing.id))
        .returning();
      if (!row) throw notFound('Preview not found');
      this.register(row, this.active.get(row.publicPort)?.server as PreviewServer);
      this.changed(row.computerId);
      return { row, token: this.tokenOf(row), created: false };
    }
    if (existing) await this.db.delete(previews).where(eq(previews.id, existing.id));

    const token = randomBytes(24).toString('base64url');
    for (let publicPort = range.first; publicPort <= range.last; publicPort++) {
      if (this.active.has(publicPort)) continue;
      const server = this.serverFor(publicPort);
      try {
        await server.listen(this.options.host);
      } catch (error) {
        // Taken by something else on this machine: the next one.
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
        throw error;
      }
      try {
        const [row] = await this.db
          .insert(previews)
          .values({
            computerId: input.computerId,
            botId: input.botId,
            title: input.title,
            port: input.port,
            publicPort,
            path: input.path,
            tokenSealed: seal(this.masterKey, TOKEN_PURPOSE, token),
            expiresAt,
          })
          .returning();
        if (!row) throw new Error('Preview insert returned no row');
        this.register(row, server);
        this.changed(row.computerId);
        return { row, token, created: true };
      } catch (error) {
        await server.close();
        // Shared at the same moment by another bot of this PC: theirs it is.
        if (isUniqueViolation(error)) return this.share(input);
        throw error;
      }
    }
    throw new HttpProblem(
      409,
      'preview_ports_full',
      `Every preview port (${range.first}-${range.last}) is in use: stop a preview first.`,
    );
  }

  async stop(id: string): Promise<void> {
    const [row] = await this.db.delete(previews).where(eq(previews.id, id)).returning();
    if (!row) throw notFound('Preview not found');
    await this.release(row.publicPort);
    this.changed(row.computerId);
  }

  /** Stops the preview of a port of the PC; false when there was none. */
  async stopPort(computerId: string, port: number): Promise<boolean> {
    const [row] = await this.db
      .delete(previews)
      .where(and(eq(previews.computerId, computerId), eq(previews.port, port)))
      .returning();
    if (!row) return false;
    await this.release(row.publicPort);
    this.changed(computerId);
    return true;
  }

  /** Ends every preview of a PC (it stopped). */
  async endComputer(computerId: string): Promise<void> {
    const rows = await this.db
      .delete(previews)
      .where(eq(previews.computerId, computerId))
      .returning();
    for (const row of rows) await this.release(row.publicPort);
    this.agents.delete(computerId);
    if (rows.length > 0) this.changed(computerId);
  }

  /** Ends expired previews, and those whose PC is gone or no longer running. */
  async sweep(now = this.now()): Promise<void> {
    const rows = await this.db.select().from(previews);
    for (const row of rows) {
      const computer = await this.computers.get(row.computerId).catch(() => null);
      if (row.expiresAt.getTime() > now && computer?.status === 'running') continue;
      await this.db.delete(previews).where(eq(previews.id, row.id));
      await this.release(row.publicPort);
      this.changed(row.computerId);
    }
    // Servers left without a row (their PC was deleted with its previews).
    const kept = new Set(rows.map((row) => row.publicPort));
    for (const publicPort of [...this.active.keys()]) {
      if (!kept.has(publicPort)) await this.release(publicPort);
    }
  }

  /** At startup: serves the previews of PCs still running again, ends the others. */
  async start(intervalMs = 60_000): Promise<void> {
    const rows = await this.db.select().from(previews);
    for (const row of rows) {
      const computer = await this.computers.get(row.computerId).catch(() => null);
      const alive =
        this.enabled && row.expiresAt.getTime() > this.now() && computer?.status === 'running';
      const server = alive ? this.serverFor(row.publicPort) : null;
      const listening =
        server &&
        (await server.listen(this.options.host).then(
          () => true,
          (error: Error) => {
            this.log.warn({ err: error, port: row.publicPort }, 'Could not serve a preview');
            return false;
          },
        ));
      if (server && listening) {
        this.register(row, server);
      } else {
        await this.db.delete(previews).where(eq(previews.id, row.id));
      }
    }
    this.timer = setInterval(() => {
      this.sweep().catch((error) => this.log.error({ err: error }, 'Preview sweep failed'));
    }, intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.active.keys()].map((port) => this.release(port)));
  }

  /** Something must listen there before the user is sent to it. */
  private async probe(computerId: string, port: number): Promise<void> {
    const agent = await this.agentOf(computerId);
    try {
      (await agent.openTunnel(port)).destroy();
    } catch (error) {
      if (error instanceof TunnelRefusedError && error.status === 502) {
        throw new HttpProblem(
          409,
          'preview_port_closed',
          `Nothing listens on port ${port} of the PC: start the server first.`,
        );
      }
      if (error instanceof TunnelRefusedError && error.status === 403) {
        throw new HttpProblem(400, 'preview_port_reserved', error.message);
      }
      throw error;
    }
  }

  private agentOf(computerId: string): Promise<AgentClient> {
    let agent = this.agents.get(computerId);
    if (!agent) {
      agent = this.computers.agentFor(computerId);
      this.agents.set(computerId, agent);
      agent.catch(() => this.agents.delete(computerId));
    }
    return agent;
  }

  private register(row: PreviewRow, server: PreviewServer): void {
    this.active.set(row.publicPort, {
      row,
      server,
      target: {
        id: row.id,
        computerId: row.computerId,
        port: row.port,
        publicPort: row.publicPort,
        token: this.tokenOf(row),
        expiresAt: row.expiresAt,
      },
    });
  }

  private async release(publicPort: number): Promise<void> {
    const active = this.active.get(publicPort);
    if (!active) return;
    this.active.delete(publicPort);
    await active.server.close();
  }

  private serverFor(publicPort: number): PreviewServer {
    return createPreviewServer(publicPort, {
      lookup: (port) => this.active.get(port)?.target ?? null,
      tunnel: async (target) => (await this.agentOf(target.computerId)).openTunnel(target.port),
      touch: (target) => {
        void this.computers.touch(target.computerId).catch(() => undefined);
      },
      trustProxy: this.options.trustProxy,
      now: this.now,
    });
  }

  private changed(computerId: string): void {
    this.events.publish({ type: 'previews.changed', computerId });
  }
}
