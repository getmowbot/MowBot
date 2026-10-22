import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { MirrorConflict, MirrorStatus, ProjectMirror } from '@mowbot/contract';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import ignore, { type Ignore } from 'ignore';
import type { Db } from '../db/client';
import { bots, projectMirrors, projects } from '../db/schema';
import type { EventBus } from '../events';
import { hubTexts } from '../i18n';
import type { NotificationService } from '../proactivity/notifications';
import type { WorkspaceFiles } from '../workspaces/files';
import {
  atLeast,
  type ConnectorService,
  type LinkListener,
  MIRROR_APP_FROM,
  type ProjectRow,
} from './service';

export type MirrorRow = typeof projectMirrors.$inferSelect;

/**
 * Never mirrored, whatever the project's .gitignore says: git's own folder, the dependencies and
 * caches each side installs or builds for itself, and system clutter. Names, at any depth.
 */
export const ALWAYS_IGNORED = [
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.gradle',
  '.dart_tool',
  '.expo',
  '.DS_Store',
  'Thumbs.db',
  // The state of the copies made before the mirror (local_pull).
  '.mowbot-sync.json',
];
const ALWAYS = new Set(ALWAYS_IGNORED);

/** Where the bots' versions of conflicting files go, outside the mirrors (not synced). */
export const CONFLICTS_DIR = 'projects/_conflicts';
/** What each mirror last agreed on with the user's folder. */
const STATE_DIR = '.mowbot/mirrors';
/** Files bigger than this stay out of a mirror (the desktop app leaves them out too). */
const MAX_FILE = 20 * 1024 * 1024;
/** One `read_files` or `put` stays under this (base64 makes it a third bigger). */
const BATCH_BYTES = 6 * 1024 * 1024;
const BATCH_FILES = 200;
/** Deleting more than this, and more than half of the project, at once looks like an accident. */
const MASS_DELETE_MIN = 20;
/** The full reconcile that catches whatever the triggers missed. */
const FULL_EVERY_MS = 2 * 60_000;
/** Apps from before the watcher: their user's changes are only seen this way. */
const UNWATCHED_EVERY_MS = 45_000;
const CONFLICTS_KEPT = 50;
/** The desktop app writes binary files (base64) from this version on. */
const BINARY_WRITES_FROM = [0, 2, 4];

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} Mo`;
const ignoredByName = (rel: string) => rel.split('/').some((part) => ALWAYS.has(part));
/** `rel` is `scope` or inside it (`''`: everything). */
const within = (rel: string, scope: string) =>
  scope === '' || rel === scope || rel.startsWith(`${scope}/`);

/** The name of a project's folder in a workspace (`projects/<slug>`). */
export function projectSlug(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'projet';
}

/** What a mirror and the user's folder last agreed on: each file's hash. */
interface MirrorState {
  v: 1;
  files: Record<string, string>;
  /** The commit the user's folder was at (null: not a git repository). */
  head: string | null;
  /** The last reconcile with the computer (null: none yet, the first copy is still to come). */
  at: string | null;
}

interface ManifestFile {
  path: string;
  size: number;
  hash: string;
  exec?: boolean;
}

interface Manifest {
  files: ManifestFile[];
  /** From 0.2.5: the files left out (too big, unreadable). */
  skipped?: string[];
  head: string | null;
  truncated: boolean;
  /** From 0.2.5: every file was seen (one neither listed nor skipped is not there). */
  complete?: boolean;
}

interface Seen {
  abs: string;
  hash: string;
  size: number;
  exec: boolean;
}

interface OpResult {
  path: string;
  ok: boolean;
  /** Changed on their side since the hub looked: left alone. */
  changed?: boolean;
  error?: string;
}

/** What one reconcile did: for the bot that asked (local_sync), the tests and the logs. */
export interface SyncReport {
  status: MirrorStatus;
  folder: string;
  online: boolean;
  /** Mirror → user's folder. */
  sent: number;
  /** User's folder → mirror. */
  received: number;
  deletedThere: number;
  deletedHere: number;
  conflicts: string[];
  /** Deleted in the mirror all at once, and put back from the user's folder. */
  restored: number;
  pending: number;
  error: string | null;
}

interface Slot {
  timer: NodeJS.Timeout | null;
  /** What the next run looks at on the user's side: null everything, a set only those paths. */
  scope: Set<string> | null | undefined;
  running: boolean;
  waiters: ((report: SyncReport | null) => void)[];
}

/** A note in a bot's conversation (BotRuntime.note): context, it does not wake the bot up. */
type NoteBot = (botId: string, text: string, display: string) => Promise<void>;

interface Deps {
  db: Db;
  events: EventBus;
  files: WorkspaceFiles;
  connectors: ConnectorService;
  notifications: NotificationService;
  limits: { maxBytes: number; maxFiles: number };
}

/**
 * Keeps a copy of each project the bots work in inside their workspace
 * (`/workspace/projects/<name>`), in sync both ways with the user's folder: a three-way reconcile
 * against what both last agreed on (a hash per file), deletions included. It runs when the
 * desktop app connects, when it reports changes, when the workspace changes, and every few
 * minutes. A file both sides changed keeps the user's version, in place and in the mirror; the
 * bots' version goes to `projects/_conflicts/`, and the user and the bots are told. `.git` is
 * never part of it.
 */
export class MirrorService implements LinkListener {
  private readonly rows = new Map<string, MirrorRow>();
  /** Connector and key of the mirrored projects, to route what their apps say. */
  private readonly places = new Map<string, { connectorId: string; key: string }>();
  private readonly slots = new Map<string, Slot>();
  /** Hashes of each mirror's files, kept while their size and modification time stay. */
  private readonly hashes = new Map<
    string,
    Map<string, { size: number; mtimeMs: number; hash: string }>
  >();
  private readonly lastFull = new Map<string, number>();
  private note: NoteBot | null = null;
  private log: { warn(obj: unknown, msg?: string): void } = { warn: () => {} };
  private unsubscribe: (() => void) | null = null;
  private ticker: NodeJS.Timeout | null = null;
  /** Set while the engine announces its own changes to a workspace (not a trigger). */
  private publishing = false;
  private closed = false;

  constructor(private readonly deps: Deps) {
    deps.connectors.setListener(this);
  }

  setNote(note: NoteBot): void {
    this.note = note;
  }

  setLogger(log: { warn(obj: unknown, msg?: string): void }): void {
    this.log = log;
  }

  /** Loads the mirrors, follows the triggers, and catches up with bots already in a project. */
  async start(): Promise<void> {
    const rows = await this.deps.db.select().from(projectMirrors);
    for (const row of rows) this.rows.set(row.id, row);
    const ids = [...new Set(rows.map((row) => row.projectId))];
    if (ids.length) {
      for (const project of await this.deps.db
        .select()
        .from(projects)
        .where(inArray(projects.id, ids))) {
        this.place(project);
      }
    }
    this.unsubscribe = this.deps.events.subscribe((event) => {
      if (event.type === 'bot.updated') {
        const { projectId, workspaceId } = event.bot;
        if (projectId && workspaceId) void this.ensure(projectId, workspaceId).catch(() => {});
      } else if (event.type === 'workspace.changed') {
        if (!this.publishing) this.workspaceChanged(event.workspaceId, event.paths);
      } else if (event.type === 'project.deleted') {
        void this.projectGone(event.projectId).catch(() => {});
      }
    });
    const working = await this.deps.db
      .select({ projectId: bots.projectId, workspaceId: bots.workspaceId })
      .from(bots)
      .where(and(isNotNull(bots.projectId), isNotNull(bots.workspaceId)));
    for (const bot of working) {
      await this.ensure(bot.projectId as string, bot.workspaceId as string).catch(() => {});
    }
    for (const row of this.rows.values()) void this.request(row.id, null, 0);
    this.ticker = setInterval(() => void this.tick().catch(() => {}), 15_000);
    this.ticker.unref();
  }

  stop(): void {
    this.closed = true;
    this.unsubscribe?.();
    if (this.ticker) clearInterval(this.ticker);
    for (const slot of this.slots.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      for (const wake of slot.waiters.splice(0)) wake(null);
    }
  }

  /** Once the reconciles under way are over (after stop, before the files go). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.runs]);
  }

  private readonly runs = new Set<Promise<void>>();

  // What the apps and the bots see

  mirrorsOf(projectId: string): ProjectMirror[] {
    return [...this.rows.values()]
      .filter((row) => row.projectId === projectId)
      .map((row) => ({
        workspaceId: row.workspaceId,
        folder: row.folder,
        status: row.status,
        pending: row.pending,
        conflicts: row.conflicts,
        error: row.error,
        syncedAt: row.syncedAt?.toISOString() ?? null,
      }));
  }

  /** The mirror of this project in this workspace, if there is one. */
  mirrorIn(projectId: string, workspaceId: string | null): MirrorRow | null {
    if (!workspaceId) return null;
    for (const row of this.rows.values()) {
      if (row.projectId === projectId && row.workspaceId === workspaceId) return row;
    }
    return null;
  }

  // Mirrors come and go

  private place(project: ProjectRow): void {
    this.places.set(project.id, { connectorId: project.connectorId, key: project.key });
  }

  /**
   * The project gets a mirror in this workspace (a bot there works in it), unless the user
   * turned mirroring off for it. The first copy starts right away when its computer is online.
   */
  async ensure(projectId: string, workspaceId: string): Promise<MirrorRow | null> {
    if (this.closed) return null;
    const existing = this.mirrorIn(projectId, workspaceId);
    if (existing) return existing;
    const [project] = await this.deps.db.select().from(projects).where(eq(projects.id, projectId));
    if (!project?.mirror) return null;
    this.place(project);
    const taken = new Set(
      [...this.rows.values()].filter((r) => r.workspaceId === workspaceId).map((r) => r.folder),
    );
    const slug = projectSlug(project.name);
    let folder = `projects/${slug}`;
    for (let n = 2; taken.has(folder); n++) folder = `projects/${slug}-${n}`;
    const [row] = await this.deps.db
      .insert(projectMirrors)
      .values({ projectId, workspaceId, folder })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      // Made meanwhile by another trigger.
      const [found] = await this.deps.db
        .select()
        .from(projectMirrors)
        .where(
          and(eq(projectMirrors.projectId, projectId), eq(projectMirrors.workspaceId, workspaceId)),
        );
      if (found) this.rows.set(found.id, found);
      return found ?? null;
    }
    this.rows.set(row.id, row);
    this.deps.connectors.publishProject(project);
    this.sendWatch(project.connectorId);
    void this.request(row.id, null, 0);
    return row;
  }

  /** The user turned the project's mirror on or off (page Projets). */
  async setEnabled(project: ProjectRow): Promise<void> {
    if (project.mirror) {
      const working = await this.deps.db
        .select({ workspaceId: bots.workspaceId })
        .from(bots)
        .where(and(eq(bots.projectId, project.id), isNotNull(bots.workspaceId)));
      for (const { workspaceId } of working) await this.ensure(project.id, workspaceId as string);
      return;
    }
    const gone = [...this.rows.values()].filter((row) => row.projectId === project.id);
    await this.deps.db.delete(projectMirrors).where(eq(projectMirrors.projectId, project.id));
    for (const row of gone) await this.retire(row);
    this.deps.connectors.publishProject(project);
    this.sendWatch(project.connectorId);
  }

  /** Unshared, or its computer unlinked: its mirrors go to the trash. */
  private async projectGone(projectId: string): Promise<void> {
    for (const row of [...this.rows.values()].filter((r) => r.projectId === projectId)) {
      await this.retire(row);
    }
    this.places.delete(projectId);
  }

  /** A mirror stops: its folder goes to its workspace's trash (nothing is lost). */
  private async retire(row: MirrorRow): Promise<void> {
    this.rows.delete(row.id);
    this.hashes.delete(row.id);
    const slot = this.slots.get(row.id);
    if (slot?.timer) clearTimeout(slot.timer);
    for (const wake of slot?.waiters.splice(0) ?? []) wake(null);
    this.slots.delete(row.id);
    const { files } = this.deps;
    await files.remove(row.workspaceId, row.folder).catch(() => {});
    await rm(path.join(files.dirOf(row.workspaceId), ...STATE_DIR.split('/'), `${row.id}.json`), {
      force: true,
    });
    this.announce(row.workspaceId, ['projects']);
  }

  // Triggers

  connected(connectorId: string): void {
    this.sendWatch(connectorId);
    for (const row of this.rowsOf(connectorId)) void this.request(row.id, null, 0);
  }

  changed(connectorId: string, key: string, paths: string[] | null): void {
    for (const row of this.rowsOf(connectorId, key)) void this.request(row.id, paths, 300);
  }

  disconnected(connectorId: string): void {
    for (const row of this.rowsOf(connectorId)) void this.request(row.id, null, 0);
  }

  /** The bots changed files: only the mirror's side needs a look. */
  private workspaceChanged(workspaceId: string, paths: string[]): void {
    for (const row of this.rows.values()) {
      if (row.workspaceId !== workspaceId) continue;
      if (paths.some((p) => within(row.folder, p) || within(p, row.folder))) {
        void this.request(row.id, [], 800);
      }
    }
  }

  /** The safety net: a full reconcile every few minutes (more often for apps without watcher). */
  private async tick(): Promise<void> {
    const now = Date.now();
    const versions = new Map<string, boolean>();
    for (const row of this.rows.values()) {
      const place = this.places.get(row.projectId);
      if (!place || !this.deps.connectors.isOnline(place.connectorId)) continue;
      if (!versions.has(place.connectorId)) {
        const version = await this.deps.connectors.versionOf(place.connectorId);
        versions.set(place.connectorId, atLeast(version, MIRROR_APP_FROM));
      }
      const every = versions.get(place.connectorId) ? FULL_EVERY_MS : UNWATCHED_EVERY_MS;
      if (now - (this.lastFull.get(row.id) ?? 0) >= every) void this.request(row.id, null, 0);
    }
  }

  private rowsOf(connectorId: string, key?: string): MirrorRow[] {
    return [...this.rows.values()].filter((row) => {
      const place = this.places.get(row.projectId);
      return place?.connectorId === connectorId && (key === undefined || place.key === key);
    });
  }

  /** Tells the app which of its folders to watch: those mirrored somewhere. */
  private sendWatch(connectorId: string): void {
    void (async () => {
      if (!atLeast(await this.deps.connectors.versionOf(connectorId), MIRROR_APP_FROM)) return;
      const keys = new Set(
        [...this.rows.values()]
          .map((row) => this.places.get(row.projectId))
          .filter((place) => place?.connectorId === connectorId)
          .map((place) => place?.key as string),
      );
      this.deps.connectors.send(connectorId, {
        t: 'watch',
        projects: [...keys],
        exclude: ALWAYS_IGNORED,
      });
    })().catch(() => {});
  }

  /**
   * Asks for a reconcile of this mirror within `delayMs` (requests close together make one
   * run). `paths`: what changed on the user's side (null: anything, []: nothing). Resolves once
   * a run that covers it is done.
   */
  request(mirrorId: string, paths: string[] | null, delayMs: number): Promise<SyncReport | null> {
    if (this.closed || !this.rows.has(mirrorId)) return Promise.resolve(null);
    let slot = this.slots.get(mirrorId);
    if (!slot) {
      slot = { timer: null, scope: undefined, running: false, waiters: [] };
      this.slots.set(mirrorId, slot);
    }
    const current = slot;
    if (paths === null || current.scope === null) current.scope = null;
    else current.scope = new Set([...(current.scope ?? []), ...paths]);
    const done = new Promise<SyncReport | null>((resolve) => current.waiters.push(resolve));
    if (!current.running) {
      if (current.timer && delayMs === 0) {
        clearTimeout(current.timer);
        current.timer = null;
      }
      if (!current.timer) {
        current.timer = setTimeout(() => {
          const run = this.drain(mirrorId);
          this.runs.add(run);
          void run.finally(() => this.runs.delete(run));
        }, delayMs);
      }
    }
    return done;
  }

  /** Right now (a bot, the user): resolves with what it did. */
  syncNow(mirrorId: string): Promise<SyncReport | null> {
    return this.request(mirrorId, null, 0);
  }

  private async drain(mirrorId: string): Promise<void> {
    const slot = this.slots.get(mirrorId);
    if (!slot || slot.running) return;
    slot.timer = null;
    while (slot.scope !== undefined && !this.closed) {
      const scope = slot.scope;
      const waiters = slot.waiters.splice(0);
      slot.scope = undefined;
      slot.running = true;
      let report: SyncReport | null = null;
      try {
        report = await this.reconcile(mirrorId, scope);
      } catch (error) {
        if (!this.closed) {
          this.log.warn({ err: error, mirrorId }, 'Mirror not reconciled');
          await this.save(mirrorId, { status: 'error', error: (error as Error).message }).catch(
            () => {},
          );
        }
      } finally {
        slot.running = false;
      }
      for (const wake of waiters) wake(report);
    }
  }

  // The reconcile

  private stateFile(row: MirrorRow): string {
    return `${STATE_DIR}/${row.id}.json`;
  }

  private async readState(row: MirrorRow): Promise<MirrorState | null> {
    const found = await this.deps.files
      .readText(row.workspaceId, this.stateFile(row), 256 * 1024 * 1024)
      .catch(() => null);
    if (!found) return null;
    try {
      const state = JSON.parse(found.text) as MirrorState;
      return state.v === 1 && state.files ? state : null;
    } catch {
      return null;
    }
  }

  private async writeState(row: MirrorRow, state: MirrorState): Promise<void> {
    await this.deps.files.writeFile(row.workspaceId, this.stateFile(row), JSON.stringify(state));
  }

  /** Saves where the mirror stands; the apps hear it when that changed. */
  private async save(
    mirrorId: string,
    values: Partial<Pick<MirrorRow, 'status' | 'pending' | 'conflicts' | 'error' | 'syncedAt'>>,
  ): Promise<void> {
    const row = this.rows.get(mirrorId);
    if (!row) return;
    const next = { ...row, ...values };
    const shown =
      next.status !== row.status ||
      next.pending !== row.pending ||
      next.error !== row.error ||
      next.conflicts !== row.conflicts;
    const synced = (next.syncedAt?.getTime() ?? 0) !== (row.syncedAt?.getTime() ?? 0);
    if (!shown && !synced) return;
    this.rows.set(mirrorId, next);
    await this.deps.db.update(projectMirrors).set(values).where(eq(projectMirrors.id, mirrorId));
    if (!shown) return;
    const project = await this.deps.connectors.project(row.projectId).catch(() => null);
    if (project) this.deps.connectors.publishProject(project);
  }

  /** The apps hear that the engine changed files in a workspace (it is not a trigger). */
  private announce(workspaceId: string, paths: string[]): void {
    this.publishing = true;
    try {
      this.deps.events.publish({ type: 'workspace.changed', workspaceId, paths });
    } finally {
      this.publishing = false;
    }
  }

  /** The mirror's files (what git would keep there), hashed, and those too big to be mirrored. */
  private async scan(
    row: MirrorRow,
    root: string,
  ): Promise<{ files: Map<string, Seen>; skipped: Set<string> }> {
    let cache = this.hashes.get(row.id);
    if (!cache) {
      cache = new Map();
      this.hashes.set(row.id, cache);
    }
    const known = cache;
    const files = new Map<string, Seen>();
    const skipped = new Set<string>();
    type Rules = { base: string; ig: Ignore }[];
    const walk = async (dir: string, rel: string, inherited: Rules): Promise<void> => {
      let rules = inherited;
      const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null);
      if (gitignore !== null) rules = [...inherited, { base: rel, ig: ignore().add(gitignore) }];
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (ALWAYS.has(name)) continue;
        const childRel = rel ? `${rel}/${name}` : name;
        const abs = path.join(dir, name);
        const info = await lstat(abs).catch(() => null);
        if (!info || info.isSymbolicLink()) continue;
        const directory = info.isDirectory();
        // Each .gitignore applies from its own folder.
        const ignored = rules.some(({ base, ig }) => {
          const local = base ? childRel.slice(base.length + 1) : childRel;
          return ig.ignores(directory ? `${local}/` : local);
        });
        if (ignored) continue;
        if (directory) {
          await walk(abs, childRel, rules);
          continue;
        }
        if (!info.isFile()) continue;
        if (info.size > MAX_FILE) {
          skipped.add(childRel);
          continue;
        }
        const cached = known.get(childRel);
        let hash =
          cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs
            ? cached.hash
            : null;
        if (!hash) {
          const content = await readFile(abs).catch(() => null);
          if (!content) continue;
          hash = sha256(content);
          // Changed within the last two seconds, it could change again unseen: not kept.
          if (Date.now() - info.mtimeMs > 2_000) {
            known.set(childRel, { size: info.size, mtimeMs: info.mtimeMs, hash });
          }
        }
        const exec = process.platform !== 'win32' && (info.mode & 0o111) !== 0;
        files.set(childRel, { abs, hash, size: info.size, exec });
      }
    };
    await walk(root, '', []);
    return { files, skipped };
  }

  /**
   * One reconcile: what changed on either side since they last agreed goes to the other.
   * `scope`: on the user's side, only these paths are looked at (what the app said changed).
   */
  private async reconcile(mirrorId: string, scope: Set<string> | null): Promise<SyncReport | null> {
    const row = this.rows.get(mirrorId);
    if (!row) return null;
    const { connectors, files } = this.deps;
    const project = await connectors.project(row.projectId).catch(() => null);
    if (!project?.mirror) return null;
    this.place(project);
    const report: SyncReport = {
      status: 'synced',
      folder: row.folder,
      online: connectors.isOnline(project.connectorId),
      sent: 0,
      received: 0,
      deletedThere: 0,
      deletedHere: 0,
      conflicts: [],
      restored: 0,
      pending: 0,
      error: null,
    };

    await files.ensure(row.workspaceId);
    const root = path.join(files.dirOf(row.workspaceId), ...row.folder.split('/'));
    const present = await lstat(root).catch(() => null);
    let state = await this.readState(row);
    if (!state) {
      // A folder already there (an older copy, files of the bots): it goes to the trash, and
      // the mirror starts from the user's folder.
      if (present && (await readdir(root).catch(() => [])).length > 0) {
        await files.remove(row.workspaceId, row.folder).catch(() => {});
        this.announce(row.workspaceId, ['projects', '.trash']);
      }
      state = { v: 1, files: {}, head: null, at: null };
      await mkdir(root, { recursive: true });
      // From now on, what the bots write there is theirs (even before the first copy).
      await this.writeState(row, state);
    } else if (!present && Object.keys(state.files).length > 0) {
      // The whole mirror went (rm -rf): copied again; nothing is deleted on their side.
      state = { v: 1, files: {}, head: state.head, at: null };
    }
    await mkdir(root, { recursive: true });
    const mine = await this.scan(row, root);

    if (!report.online) {
      report.pending = countPending(state, mine.files);
      report.status = state.at ? (report.pending ? 'pending' : 'synced') : 'waiting';
      await this.save(row.id, { status: report.status, pending: report.pending, error: null });
      return report;
    }

    const version = await connectors.versionOf(project.connectorId);
    const modern = atLeast(version, MIRROR_APP_FROM);
    const binaries = atLeast(version, BINARY_WRITES_FROM);
    // Without a watcher (older apps), their side is always looked at in full.
    const scoped = modern && scope !== null;
    const manifest: Manifest =
      scoped && scope.size === 0
        ? { files: [], skipped: [], head: state.head, truncated: false, complete: true }
        : await connectors.request<Manifest>(
            project,
            'manifest',
            { rules: 'project', exclude: ALWAYS_IGNORED, ...(scoped ? { paths: [...scope] } : {}) },
            180_000,
          );
    if (!scoped) this.lastFull.set(row.id, Date.now());
    const theirs = new Map(
      manifest.files.filter((f) => !ignoredByName(f.path)).map((f) => [f.path, f]),
    );
    const theirSkipped = new Set(manifest.skipped ?? []);
    // Older apps only say that some files were left out, not which: a missing one is unknown.
    const complete = manifest.complete ?? !manifest.truncated;

    if (!scoped) {
      const { maxBytes, maxFiles } = this.deps.limits;
      const bytes = Math.max(total(theirs.values()), total(mine.files.values()));
      const count = Math.max(theirs.size, mine.files.size);
      if (bytes > maxBytes || count > maxFiles) {
        report.status = 'too_big';
        report.error = `Projet trop gros pour un miroir : ${mb(bytes)}, ${plural(count, 'fichier')} (limite : ${mb(maxBytes)}, ${plural(maxFiles, 'fichier')}). Ajoute les dossiers générés à son .gitignore, ou désactive son miroir (page Projets) : les bots travailleront alors directement sur l'ordinateur.`;
        await this.save(row.id, { status: 'too_big', pending: 0, error: report.error });
        return report;
      }
      state.head = manifest.head;
    }

    // Each side of a path: its hash, null when there is no file, undefined when unknown.
    const scopes = scope ? [...scope] : [];
    const theirHash = (rel: string): string | null | undefined => {
      // Not looked at this time: as they last agreed (a write there checks it anyway).
      if (scoped && !scopes.some((s) => within(rel, s))) return state.files[rel] ?? null;
      const found = theirs.get(rel);
      if (found) return found.hash;
      return theirSkipped.has(rel) || !complete ? undefined : null;
    };
    const myHash = (rel: string): string | null | undefined =>
      mine.files.get(rel)?.hash ?? (mine.skipped.has(rel) ? undefined : null);

    /** Their hash when it was looked at: what a change there expects to find. */
    const seenThere = new Map<string, string | null>();
    const toThem: string[] = [];
    const deleteThere: string[] = [];
    const toMe: string[] = [];
    const deleteHere: string[] = [];
    const conflicts: string[] = [];
    const every = new Set([...theirs.keys(), ...mine.files.keys(), ...Object.keys(state.files)]);
    for (const rel of every) {
      if (ignoredByName(rel)) continue;
      const was = state.files[rel] ?? null;
      const u = theirHash(rel);
      const m = myHash(rel);
      if (u === undefined || m === undefined) continue;
      if (u === m) {
        if (u === null) delete state.files[rel];
        else state.files[rel] = u;
        continue;
      }
      seenThere.set(rel, u);
      if (u === was) {
        if (m === null) deleteThere.push(rel);
        else toThem.push(rel);
      } else if (m === was) {
        if (u === null) deleteHere.push(rel);
        else toMe.push(rel);
      } else if (u === null) {
        // Deleted there, changed here: the change wins, the file goes back there.
        toThem.push(rel);
      } else if (m === null) {
        toMe.push(rel);
      } else {
        conflicts.push(rel);
      }
    }

    // Most of the project deleted at once in the mirror: put back, not deleted on their side.
    const tracked = Object.keys(state.files).length;
    if (deleteThere.length > MASS_DELETE_MIN && deleteThere.length > tracked / 2) {
      report.restored = deleteThere.length;
      toMe.push(...deleteThere.splice(0));
    }

    const work =
      toThem.length + deleteThere.length + toMe.length + deleteHere.length + conflicts.length;
    if (work > 0) await this.save(row.id, { status: 'syncing' });

    // Both changed: the bots' version is kept aside, the user's version comes into the mirror.
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '');
    const conflictDir = `${CONFLICTS_DIR}/${path.posix.basename(row.folder)}/${stamp}`;
    const kept: MirrorConflict[] = [];
    for (const rel of conflicts) {
      const seen = mine.files.get(rel);
      const content = seen && (await readFile(seen.abs).catch(() => null));
      if (!content) continue;
      const copy = `${conflictDir}/${rel}`;
      await files.writeFile(row.workspaceId, copy, content);
      kept.push({ path: rel, copy, at: new Date().toISOString() });
      toMe.push(rel);
    }
    report.conflicts = kept.map((c) => c.path);

    let pending = 0;
    let needsUpdate = false;
    let retry = false;
    const errors: string[] = [];
    const failed = (rel: string, error: string) => {
      pending += 1;
      if (errors.length < 3) errors.push(`${rel} : ${error}`);
    };
    const outcome = (result: OpResult, done: () => void) => {
      if (result.ok) done();
      else if (result.changed) retry = true;
      else failed(result.path, result.error ?? 'échec');
    };

    // Mirror → their folder. Deletions first (a renamed file on a disk that ignores case).
    if (deleteThere.length && !modern) {
      needsUpdate = true;
      pending += deleteThere.length;
    } else {
      for (let i = 0; i < deleteThere.length; i += BATCH_FILES) {
        const batch = deleteThere.slice(i, i + BATCH_FILES);
        const { results } = await connectors.request<{ results: OpResult[] }>(
          project,
          'delete',
          { files: batch.map((rel) => ({ path: rel, expect: seenThere.get(rel) ?? null })) },
          120_000,
        );
        for (const result of results) {
          outcome(result, () => {
            delete state.files[result.path];
            report.deletedThere += 1;
          });
        }
      }
    }
    const sending: { rel: string; content: Buffer; exec: boolean }[] = [];
    for (const rel of toThem) {
      const seen = mine.files.get(rel);
      // Read as it is now: a bot may have changed it again since the scan.
      const content = seen && (await readFile(seen.abs).catch(() => null));
      if (seen && content) sending.push({ rel, content, exec: seen.exec });
    }
    for (const batch of batches(sending, (item) => item.content.length)) {
      if (modern) {
        const { results } = await connectors.request<{ results: OpResult[] }>(
          project,
          'put',
          {
            files: batch.map(({ rel, content, exec }) => ({
              path: rel,
              data: content.toString('base64'),
              expect: seenThere.get(rel) ?? null,
              ...(exec ? { exec: true } : {}),
            })),
          },
          180_000,
        );
        for (const result of results) {
          const item = batch.find((b) => b.rel === result.path);
          outcome(result, () => {
            if (item) state.files[result.path] = sha256(item.content);
            report.sent += 1;
          });
        }
        continue;
      }
      for (const { rel, content } of batch) {
        const text = asText(content);
        if (text === null && !binaries) {
          needsUpdate = true;
          pending += 1;
          continue;
        }
        try {
          await connectors.request(
            project,
            'write',
            text === null
              ? { path: rel, content: content.toString('base64'), base64: true }
              : { path: rel, content: text },
            60_000,
          );
          state.files[rel] = sha256(content);
          report.sent += 1;
        } catch (error) {
          failed(rel, (error as Error).message);
        }
      }
    }

    // Their folder → mirror.
    let touched = false;
    const unchangedHere = async (rel: string) => {
      const seen = mine.files.get(rel);
      if (!seen) return true;
      const now = await readFile(seen.abs).catch(() => null);
      return !now || sha256(now) === seen.hash;
    };
    for (const rel of deleteHere) {
      // Changed by a bot since the scan: left for the next round.
      if (!(await unchangedHere(rel))) continue;
      const abs = path.join(root, ...rel.split('/'));
      await rm(abs, { force: true });
      await removeEmptyParents(root, abs);
      this.hashes.get(row.id)?.delete(rel);
      delete state.files[rel];
      report.deletedHere += 1;
      touched = true;
    }
    const conflicted = new Set(kept.map((c) => c.path));
    const wanted = toMe
      .map((rel) => ({ rel, size: theirs.get(rel)?.size ?? 0, exec: theirs.get(rel)?.exec }))
      .filter((item) => item.size <= MAX_FILE);
    for (const batch of batches(wanted, (item) => item.size)) {
      const got = await this.readTheirs(
        project,
        batch.map((item) => item.rel),
      );
      for (const { path: rel, data } of got) {
        if (!conflicted.has(rel) && !(await unchangedHere(rel))) continue;
        const content = Buffer.from(data, 'base64');
        const fresh = !mine.files.has(rel);
        try {
          await files.writeFile(row.workspaceId, `${row.folder}/${rel}`, content);
        } catch (error) {
          failed(rel, (error as Error).message);
          continue;
        }
        if (fresh && batch.find((item) => item.rel === rel)?.exec) {
          await chmod(path.join(root, ...rel.split('/')), 0o755).catch(() => {});
        }
        this.hashes.get(row.id)?.delete(rel);
        state.files[rel] = sha256(content);
        if (!conflicted.has(rel)) report.received += 1;
        touched = true;
      }
    }

    state.at = new Date().toISOString();
    await this.writeState(row, state);
    if (touched || kept.length) {
      this.announce(row.workspaceId, kept.length ? [row.folder, CONFLICTS_DIR] : [row.folder]);
    }
    if (retry) {
      // Something changed on their side while this ran: another round, with what it is now.
      setTimeout(() => void this.request(row.id, null, 0), 1_000).unref();
    }

    report.pending = pending;
    report.error = needsUpdate
      ? "L'app MowBot desktop de cet ordinateur doit être mise à jour pour recevoir les suppressions et les fichiers binaires faits dans le miroir."
      : errors.length
        ? errors.join(' ; ')
        : null;
    report.status = pending ? 'pending' : 'synced';
    const before = this.rows.get(row.id)?.conflicts ?? [];
    await this.save(row.id, {
      status: report.status,
      pending,
      error: report.error,
      conflicts: kept.length ? [...kept, ...before].slice(0, CONFLICTS_KEPT) : before,
      syncedAt: new Date(),
    });
    if (kept.length || report.restored) {
      await this.tell(row, project, kept, conflictDir, report.restored);
    }
    return report;
  }

  /** Their files, in batches; one gone meanwhile only leaves itself out. */
  private async readTheirs(
    project: ProjectRow,
    paths: string[],
  ): Promise<{ path: string; data: string }[]> {
    try {
      const { files } = await this.deps.connectors.request<{
        files: { path: string; data: string }[];
      }>(project, 'read_files', { paths }, 180_000);
      return files;
    } catch {
      if (paths.length === 1) return [];
      const got: { path: string; data: string }[] = [];
      for (const one of paths) got.push(...(await this.readTheirs(project, [one])));
      return got;
    }
  }

  /** The user and the bots working in the mirror hear about conflicts and put-back files. */
  private async tell(
    row: MirrorRow,
    project: ProjectRow,
    conflicts: MirrorConflict[],
    conflictDir: string,
    restored: number,
  ): Promise<void> {
    const texts = await hubTexts(this.deps.db);
    const working = await this.deps.db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.projectId, project.id), eq(bots.workspaceId, row.workspaceId)));
    const where = `/workspace/${row.folder}`;
    if (conflicts.length) {
      const list = conflicts.map((c) => c.path);
      const shown = list.slice(0, 10).join(', ') + (list.length > 10 ? '…' : '');
      await this.deps.notifications
        .create({
          botId: working[0]?.id ?? null,
          priority: 'normal',
          title: texts.mirrorConflicts(project.name, list.length),
          body: texts.mirrorConflictsBody(shown, `/workspace/${conflictDir}`),
        })
        .catch(() => {});
      for (const bot of working) {
        await this.note?.(
          bot.id,
          `[Conflit dans le projet ${project.name} : l'utilisateur et vous avez changé les mêmes fichiers depuis la dernière synchro (${shown}). Sa version est gardée, dans son dossier comme dans ${where} ; la vôtre est dans /workspace/${conflictDir}/. Reporte tes changements sur sa version s'il le faut.]`,
          texts.mirrorConflictsNote(project.name, list.length),
        ).catch(() => {});
      }
    }
    if (restored) {
      for (const bot of working) {
        await this.note?.(
          bot.id,
          `[${plural(restored, 'fichier')} du projet ${project.name} supprimés d'un coup dans ${where} : par sécurité, ils y sont revenus depuis l'ordinateur de l'utilisateur, où ils n'ont pas été supprimés. Supprime-les par petits groupes si c'était voulu.]`,
          texts.mirrorRestored(project.name, restored),
        ).catch(() => {});
      }
    }
  }

  /** Dismisses conflicts (all, or one file's); the bots' copies go to the trash. */
  async dismissConflicts(projectId: string, workspaceId: string, file?: string): Promise<void> {
    const row = this.mirrorIn(projectId, workspaceId);
    if (!row) return;
    const going = row.conflicts.filter((c) => file === undefined || c.path === file);
    for (const conflict of going) {
      await this.deps.files.remove(workspaceId, conflict.copy).catch(() => {});
    }
    await this.save(row.id, { conflicts: row.conflicts.filter((c) => !going.includes(c)) });
    this.announce(workspaceId, [CONFLICTS_DIR]);
  }
}

/** What is in the mirror and not yet in their folder, while the computer is away. */
function countPending(state: MirrorState, mine: Map<string, Seen>): number {
  let count = 0;
  for (const [rel, seen] of mine) if (state.files[rel] !== seen.hash) count += 1;
  for (const rel of Object.keys(state.files)) if (!mine.has(rel)) count += 1;
  return count;
}

function total(items: Iterable<{ size: number }>): number {
  let sum = 0;
  for (const item of items) sum += item.size;
  return sum;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The file as text, or null when it is binary. */
function asText(content: Buffer): string | null {
  if (content.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(content);
  } catch {
    return null;
  }
}

/** Items in groups of at most BATCH_FILES and about BATCH_BYTES (a bigger one goes alone). */
function* batches<T>(items: T[], size: (item: T) => number): Generator<T[]> {
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const weight = size(item);
    if (batch.length && (batch.length >= BATCH_FILES || bytes + weight > BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(item);
    bytes += weight;
  }
  if (batch.length) yield batch;
}

/** The folders a deletion left empty go too, up to the mirror's root. */
async function removeEmptyParents(root: string, file: string): Promise<void> {
  let dir = path.dirname(file);
  while (dir.startsWith(root + path.sep)) {
    const names = await readdir(dir).catch(() => null);
    if (!names || names.length > 0) return;
    await rmdir(dir).catch(() => {});
    dir = path.dirname(dir);
  }
}
