import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type Connector,
  type ConnectorCreate,
  connectorOsSchema,
  type Project,
  type ProjectUpdate,
} from '@mowbot/contract';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import WebSocket from 'ws';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { Db } from '../db/client';
import { connectors, projectGrants, projects } from '../db/schema';
import type { EventBus } from '../events';
import { notFound } from '../http/problems';
import { HUB_TEXTS } from '../i18n';

export type ConnectorRow = typeof connectors.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

/** What a connector does on a project: see docs/DESKTOP.md. */
export type ProjectOp = 'list' | 'read' | 'write' | 'edit' | 'find' | 'search' | 'exec';

const KEEPALIVE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Close code telling the desktop app its token is no longer valid (it stops retrying). */
export const REVOKED_CLOSE_CODE = 4401;

const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url');

const announcedSchema = z.object({
  key: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  path: z.string().max(1024),
});

const frameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    version: z.string().max(40).optional(),
    hostname: z.string().max(200).optional(),
    os: connectorOsSchema.optional(),
    shell: z.string().max(40).optional(),
    projects: z.array(announcedSchema).max(200),
  }),
  z.object({ t: z.literal('projects'), projects: z.array(announcedSchema).max(200) }),
  z.object({
    t: z.literal('res'),
    id: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Link {
  socket: WebSocket;
  pending: Map<string, Pending>;
}

export function toConnector(row: ConnectorRow, online: boolean): Connector {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    shell: row.shell,
    version: row.version,
    online,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The desktop apps of the user's computers and the folders shared there (projects): their
 * tokens, their live connections, and the requests bots make on the projects through them.
 */
export class ConnectorService {
  private readonly links = new Map<string, Link>();

  constructor(private readonly deps: { db: Db; events: EventBus }) {}

  // Connectors

  async create(input: ConnectorCreate): Promise<{ connector: Connector; token: string }> {
    const token = `mbc_${randomBytes(32).toString('base64url')}`;
    const [row] = await this.deps.db
      .insert(connectors)
      .values({ name: input.name, tokenHash: hashToken(token) })
      .returning();
    if (!row) throw new Error('Connector insert returned no row');
    const connector = toConnector(row, false);
    this.deps.events.publish({ type: 'connector.updated', connector });
    return { connector, token };
  }

  async list(): Promise<Connector[]> {
    const rows = await this.deps.db.select().from(connectors).orderBy(asc(connectors.createdAt));
    return rows.map((row) => toConnector(row, this.links.has(row.id)));
  }

  /** Forgets a computer: its app is disconnected for good and its projects go. */
  async remove(id: string): Promise<void> {
    const gone = await this.deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.connectorId, id));
    const [row] = await this.deps.db.delete(connectors).where(eq(connectors.id, id)).returning();
    if (!row) throw notFound('Connector not found');
    this.links.get(id)?.socket.close(REVOKED_CLOSE_CODE, 'Revoked');
    for (const project of gone) {
      this.deps.events.publish({ type: 'project.deleted', projectId: project.id });
    }
    this.deps.events.publish({ type: 'connector.deleted', connectorId: id });
  }

  async authenticate(token: string): Promise<ConnectorRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(connectors)
      .where(eq(connectors.tokenHash, hashToken(token)));
    return row ?? null;
  }

  isOnline(connectorId: string): boolean {
    return this.links.has(connectorId);
  }

  /** A desktop app connected: it says what it is and which folders it shares. */
  attach(row: ConnectorRow, socket: WebSocket): void {
    // A second connection of the same app replaces the first.
    this.links.get(row.id)?.socket.close(1000, 'Replaced');
    const link: Link = { socket, pending: new Map() };
    this.links.set(row.id, link);
    const keepalive = setInterval(() => socket.ping(), KEEPALIVE_MS);
    let chain = Promise.resolve();
    socket.on('message', (data: WebSocket.RawData) => {
      let frame: z.infer<typeof frameSchema>;
      try {
        frame = frameSchema.parse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (frame.t === 'res') {
        const pending = link.pending.get(frame.id);
        if (!pending) return;
        link.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.data);
        else pending.reject(new Error(frame.error ?? 'Échec sur le PC de l’utilisateur'));
        return;
      }
      // Announcements are applied in order.
      chain = chain.then(() => this.announced(row.id, frame)).catch(() => undefined);
    });
    socket.on('close', () => {
      clearInterval(keepalive);
      for (const pending of link.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Le PC de l’utilisateur s’est déconnecté pendant la demande.'));
      }
      if (this.links.get(row.id) !== link) return;
      this.links.delete(row.id);
      void this.seen(row.id).catch(() => undefined);
    });
  }

  private async announced(
    connectorId: string,
    frame: Extract<z.infer<typeof frameSchema>, { t: 'hello' | 'projects' }>,
  ): Promise<void> {
    if (frame.t === 'hello') {
      await this.deps.db
        .update(connectors)
        .set({
          hostname: frame.hostname ?? null,
          os: frame.os ?? null,
          shell: frame.shell ?? null,
          version: frame.version ?? null,
        })
        .where(eq(connectors.id, connectorId));
    }
    await this.syncProjects(connectorId, frame.projects);
    await this.seen(connectorId);
  }

  /** The app's shared folders become the connector's projects (settings kept by key). */
  private async syncProjects(
    connectorId: string,
    announced: z.infer<typeof announcedSchema>[],
  ): Promise<void> {
    const keys = announced.map((p) => p.key);
    const removed = await this.deps.db
      .delete(projects)
      .where(
        and(
          eq(projects.connectorId, connectorId),
          keys.length ? notInArray(projects.key, keys) : undefined,
        ),
      )
      .returning({ id: projects.id });
    for (const { id } of removed)
      this.deps.events.publish({ type: 'project.deleted', projectId: id });
    for (const shared of announced) {
      const [row] = await this.deps.db
        .insert(projects)
        .values({ connectorId, key: shared.key, name: shared.name, path: shared.path })
        .onConflictDoUpdate({
          target: [projects.connectorId, projects.key],
          // The name stays the one the user may have changed in the app.
          set: { path: shared.path, updatedAt: new Date() },
        })
        .returning();
      if (row) this.publishProject(row);
    }
  }

  /** Last seen now; everyone hears whether it is online. */
  private async seen(connectorId: string): Promise<void> {
    const [row] = await this.deps.db
      .update(connectors)
      .set({ lastSeenAt: new Date() })
      .where(eq(connectors.id, connectorId))
      .returning();
    if (!row) return;
    const online = this.links.has(row.id);
    this.deps.events.publish({ type: 'connector.updated', connector: toConnector(row, online) });
    const rows = await this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.connectorId, connectorId));
    for (const project of rows) this.publishProject(project);
  }

  // Projects

  toProject(row: ProjectRow): Project {
    return {
      id: row.id,
      connectorId: row.connectorId,
      name: row.name,
      path: row.path,
      mode: row.mode,
      scope: row.scope,
      online: this.links.has(row.connectorId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private publishProject(row: ProjectRow): void {
    this.deps.events.publish({ type: 'project.updated', project: this.toProject(row) });
  }

  async projects(): Promise<ProjectRow[]> {
    return this.deps.db.select().from(projects).orderBy(asc(projects.name));
  }

  async project(id: string): Promise<ProjectRow> {
    const [row] = await this.deps.db.select().from(projects).where(eq(projects.id, id));
    if (!row) throw notFound('Project not found');
    return row;
  }

  async updateProject(id: string, patch: ProjectUpdate): Promise<ProjectRow> {
    const [row] = await this.deps.db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!row) throw notFound('Project not found');
    this.publishProject(row);
    return row;
  }

  /** The projects this bot may work in. */
  async accessibleTo(bot: BotRow): Promise<ProjectRow[]> {
    const rows = await this.projects();
    return rows.filter((row) => {
      if (row.scope.kind === 'all') return true;
      if (row.scope.kind === 'bots') return row.scope.ids.includes(bot.id);
      return bot.teamId !== null && row.scope.ids.includes(bot.teamId);
    });
  }

  /** What each project's computer is, for the bots (OS, shell). */
  async connectorsOf(rows: ProjectRow[]): Promise<Map<string, ConnectorRow>> {
    const ids = [...new Set(rows.map((row) => row.connectorId))];
    if (ids.length === 0) return new Map();
    const found = await this.deps.db.select().from(connectors).where(inArray(connectors.id, ids));
    return new Map(found.map((row) => [row.id, row]));
  }

  // Commands the user allowed once

  async grant(projectId: string, botId: string, command: string): Promise<void> {
    await this.deps.db.insert(projectGrants).values({ projectId, botId, command });
  }

  /** Uses up an approval of exactly this command, if there is one. */
  async consumeGrant(projectId: string, botId: string, command: string): Promise<boolean> {
    const [grant] = await this.deps.db
      .select({ id: projectGrants.id })
      .from(projectGrants)
      .where(
        and(
          eq(projectGrants.projectId, projectId),
          eq(projectGrants.botId, botId),
          eq(projectGrants.command, command),
        ),
      )
      .limit(1);
    if (!grant) return false;
    await this.deps.db.delete(projectGrants).where(eq(projectGrants.id, grant.id));
    return true;
  }

  /** The user answered a command approval: once, the whole project, or no. */
  async commandAnswered(
    about: { projectId: string; command: string },
    botId: string,
    answer: string,
  ): Promise<void> {
    const said = answer.trim().toLowerCase();
    const is = (index: 0 | 1) =>
      Object.values(HUB_TEXTS).some((texts) => texts.commandAnswers[index].toLowerCase() === said);
    if (is(1)) await this.updateProject(about.projectId, { mode: 'auto' }).catch(() => undefined);
    else if (is(0)) await this.grant(about.projectId, botId, about.command).catch(() => undefined);
  }

  // Requests

  /** Asks the project's computer to do something; its answer, or its error for the bot. */
  async request<T>(
    row: ProjectRow,
    op: ProjectOp,
    args: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const link = this.links.get(row.connectorId);
    if (!link || link.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `L'ordinateur de « ${row.name} » n'est pas connecté : l'utilisateur doit ouvrir l'app MowBot desktop.`,
      );
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error(`Pas de réponse de l'ordinateur de l'utilisateur (${op}).`));
      }, timeoutMs);
      link.pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
      link.socket.send(JSON.stringify({ t: 'req', id, op, project: row.key, args }));
    });
  }

  close(): void {
    for (const link of this.links.values()) link.socket.close(1001, 'Hub stopping');
    this.links.clear();
  }
}
