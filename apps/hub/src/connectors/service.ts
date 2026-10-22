import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type Connector,
  type ConnectorCreate,
  connectorOsSchema,
  type Project,
  type ProjectMirror,
  type ProjectUpdate,
} from '@mowbot/contract';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';
import WebSocket from 'ws';
import { z } from 'zod';
import type { BotRow, BotService } from '../bots/service';
import type { Db } from '../db/client';
import { bots, connectors, projectGrants, projects } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { HUB_TEXTS } from '../i18n';

export type ConnectorRow = typeof connectors.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;

/** What a connector does on a project: see docs/DESKTOP.md. */
export type ProjectOp =
  | 'list'
  | 'read'
  | 'write'
  | 'edit'
  | 'find'
  | 'search'
  | 'exec'
  | 'manifest'
  | 'read_files'
  | 'put'
  | 'delete';

/** Whether a desktop app version is at least `wanted` (`[0, 2, 5]`); unknown versions are not. */
export function atLeast(version: string | null | undefined, wanted: number[]): boolean {
  const parts = (version ?? '').split(/[.-]/).map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < wanted.length; i++) {
    const have = parts[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== wanted[i]) return have > (wanted[i] as number);
  }
  return true;
}

/** The desktop app has `put`, `delete`, mirror manifests, `watch` and `pick` from this version. */
export const MIRROR_APP_FROM = [0, 2, 5];

/** What the mirror engine hears from the connections (connectors/mirror.ts). */
export interface LinkListener {
  /** The app connected and announced its folders. */
  connected(connectorId: string): void;
  /** Files changed in a project it watches (null: anything may have). */
  changed(connectorId: string, key: string, paths: string[] | null): void;
  disconnected(connectorId: string): void;
  /** Where the project's mirrors stand, for the apps. */
  mirrorsOf(projectId: string): ProjectMirror[];
}

const KEEPALIVE_MS = 25_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long the user has to pick a folder on their computer. */
const PICK_TIMEOUT_MS = 5 * 60_000;
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
    t: z.literal('changed'),
    project: z.string().max(100),
    paths: z.array(z.string().max(4096)).max(1000).nullable(),
  }),
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
  /** Its announcements, applied in order. */
  chain: Promise<void>;
}

/** Whether this bot may work in the project (its scope: all bots, some teams, some bots). */
export function usableBy(row: ProjectRow, bot: Pick<BotRow, 'id' | 'teamId'>): boolean {
  if (row.scope.kind === 'all') return true;
  if (row.scope.kind === 'bots') return row.scope.ids.includes(bot.id);
  return bot.teamId !== null && row.scope.ids.includes(bot.teamId);
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
  private listener: LinkListener | null = null;

  constructor(private readonly deps: { db: Db; events: EventBus; bots: BotService }) {}

  /** The mirror engine follows the connections. */
  setListener(listener: LinkListener): void {
    this.listener = listener;
  }

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
    const working = await this.botsIn(gone.map((project) => project.id));
    const [row] = await this.deps.db.delete(connectors).where(eq(connectors.id, id)).returning();
    if (!row) throw notFound('Connector not found');
    this.links.get(id)?.socket.close(REVOKED_CLOSE_CODE, 'Revoked');
    for (const project of gone) {
      this.deps.events.publish({ type: 'project.deleted', projectId: project.id });
    }
    this.deps.events.publish({ type: 'connector.deleted', connectorId: id });
    await this.publishBots(working);
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
    const link: Link = { socket, pending: new Map(), chain: Promise.resolve() };
    this.links.set(row.id, link);
    const keepalive = setInterval(() => socket.ping(), KEEPALIVE_MS);
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
      if (frame.t === 'changed') {
        const { project, paths } = frame;
        link.chain = link.chain
          .then(() => this.listener?.changed(row.id, project, paths))
          .catch(() => undefined);
        return;
      }
      // Announcements are applied in order; once the app said hello, its mirrors catch up.
      link.chain = link.chain
        .then(() => this.announced(row.id, frame))
        .then(() => {
          if (frame.t === 'hello' && this.links.get(row.id) === link) {
            this.listener?.connected(row.id);
          }
        })
        .catch(() => undefined);
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
      this.listener?.disconnected(row.id);
    });
  }

  /** Once the folders the app announced so far are known here. */
  async settled(connectorId: string): Promise<void> {
    await this.links.get(connectorId)?.chain;
  }

  /** Sends a message to a connected app (false: not connected). */
  send(connectorId: string, frame: Record<string, unknown>): boolean {
    const link = this.links.get(connectorId);
    if (!link || link.socket.readyState !== WebSocket.OPEN) return false;
    link.socket.send(JSON.stringify(frame));
    return true;
  }

  /** The version the app of this computer said it is. */
  async versionOf(connectorId: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ version: connectors.version })
      .from(connectors)
      .where(eq(connectors.id, connectorId));
    return row?.version ?? null;
  }

  /**
   * Opens the folder picker on the computer (asked from another device): the project the user
   * picked there, or null when they cancelled.
   */
  async pick(connectorId: string): Promise<ProjectRow | null> {
    const link = this.links.get(connectorId);
    if (!link || link.socket.readyState !== WebSocket.OPEN) {
      throw new HttpProblem(409, 'connector_offline', 'This computer is not connected');
    }
    if (!atLeast(await this.versionOf(connectorId), MIRROR_APP_FROM)) {
      throw new HttpProblem(409, 'app_update_needed', 'The desktop app needs an update for this');
    }
    const picked = await this.call<{ key: string } | null>(
      link,
      (id) => ({ t: 'pick', id }),
      PICK_TIMEOUT_MS,
      'pick',
    );
    if (!picked) return null;
    await this.settled(connectorId);
    const [row] = await this.deps.db
      .select()
      .from(projects)
      .where(and(eq(projects.connectorId, connectorId), eq(projects.key, picked.key)));
    return row ?? null;
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
    const unshared = and(
      eq(projects.connectorId, connectorId),
      keys.length ? notInArray(projects.key, keys) : undefined,
    );
    const going = await this.deps.db.select({ id: projects.id }).from(projects).where(unshared);
    const working = await this.botsIn(going.map((project) => project.id));
    const removed = await this.deps.db
      .delete(projects)
      .where(unshared)
      .returning({ id: projects.id });
    for (const { id } of removed)
      this.deps.events.publish({ type: 'project.deleted', projectId: id });
    await this.publishBots(working);
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
      key: row.key,
      name: row.name,
      path: row.path,
      mode: row.mode,
      scope: row.scope,
      online: this.links.has(row.connectorId),
      mirror: row.mirror,
      mirrors: this.listener?.mirrorsOf(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  publishProject(row: ProjectRow): void {
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
    return (await this.projects()).filter((row) => usableBy(row, bot));
  }

  /** The bots working in these projects, before the projects go (which clears it). */
  private async botsIn(projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await this.deps.db
      .select({ id: bots.id })
      .from(bots)
      .where(inArray(bots.projectId, projectIds));
    return rows.map((row) => row.id);
  }

  /** Everyone hears these bots changed: their project went. */
  private async publishBots(botIds: string[]): Promise<void> {
    if (botIds.length === 0) return;
    const rows = await this.deps.db.select().from(bots).where(inArray(bots.id, botIds));
    for (const row of rows) this.deps.bots.publish(row);
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
    return this.call<T>(
      link,
      (id) => ({ t: 'req', id, op, project: row.key, args }),
      timeoutMs,
      op,
    );
  }

  /** Sends a message that the app answers with `res` (same id). */
  private call<T>(
    link: Link,
    frame: (id: string) => Record<string, unknown>,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error(`Pas de réponse de l'ordinateur de l'utilisateur (${what}).`));
      }, timeoutMs);
      link.pending.set(id, { resolve: (data) => resolve(data as T), reject, timer });
      link.socket.send(JSON.stringify(frame(id)));
    });
  }

  close(): void {
    for (const link of this.links.values()) link.socket.close(1001, 'Hub stopping');
    this.links.clear();
  }
}
