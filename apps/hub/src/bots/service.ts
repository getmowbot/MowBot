import type { Bot, BotActivity, BotUpdate, Message, MessagePart } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bots, messages, tasks } from '../db/schema';
import type { EventBus } from '../events';
import { notFound } from '../http/problems';
import type { WorkspaceFiles } from '../workspaces/files';
import { BotActivities } from './activity';
import { DoingTasks } from './focus';

export type BotRow = typeof bots.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

/**
 * `activity`: the tool call it runs; `doing`: the title of the task it is doing (BotService
 * knows both; a new bot does nothing yet).
 */
export function toBot(
  row: BotRow,
  { activity = null, doing = null }: { activity?: BotActivity | null; doing?: string | null } = {},
): Bot {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    mission: row.mission,
    isChef: row.isChef,
    teamId: row.teamId,
    computerId: row.computerId,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    model: row.model,
    fallbacks: row.fallbacks,
    lightModel: row.lightModel ?? null,
    heartbeatMinutes: row.heartbeatMinutes,
    dailyTokenBudget: row.dailyTokenBudget,
    status: row.status,
    statusDetail: row.statusDetail,
    activity,
    focus: row.focus ?? doing,
    avatarSeed: row.avatarSeed,
    managerId: row.managerId,
    projectId: row.projectId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    botId: row.botId,
    role: row.role,
    fromBotId: row.fromBotId,
    fromName: row.meta?.fromName ?? null,
    summary: row.meta?.summary ?? null,
    kind: row.kind,
    taskId: row.meta?.taskId ?? null,
    parts: row.parts,
    steered: Boolean(row.meta?.steeredInto),
    steeredInto: row.meta?.steeredInto ?? null,
    autonomous: Boolean(row.meta?.autonomous),
    mentions: row.meta?.mentions ?? [],
    status: row.status,
    stepLimit: Boolean(row.meta?.stepLimit),
    resume: row.meta?.resume ?? null,
    errorCode: row.errorCode ?? null,
    error: row.error,
    usage: row.usage ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Folder of a bot inside its workspace: `bots/<slug>`. */
export function botFolder(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `bots/${slug || 'bot'}`;
}

/** What changes of a bot on its own (what it runs, its task), as last sent: same, nothing to say. */
const liveKey = (bot: Bot) => JSON.stringify([bot.activity, bot.focus]);

/** A bot's activity goes out at most this often: a burst of quick tool calls is one event. */
export const ACTIVITY_PUBLISH_MS = 300;

export class BotService {
  /** The tool calls the bots are running (in memory), shown with them. */
  readonly activity = new BotActivities((botId) => this.publishSoon(botId));
  /** The tasks the bots are doing: what they work on when they did not say it. */
  private readonly doing = new DoingTasks();
  /** Changes waiting to go out, by bot. */
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** How each bot last went out (`liveKey`). */
  private readonly published = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly publishDelayMs = ACTIVITY_PUBLISH_MS,
  ) {}

  toBot(row: BotRow): Bot {
    return toBot(row, { activity: this.activity.of(row.id), doing: this.doing.titleOf(row.id) });
  }

  /** Follows the tasks being done: their titles are the focus of the bots that set none. */
  async watchTasks(): Promise<void> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.status, 'doing'));
    for (const row of rows) this.doing.take({ ...row, updatedAt: row.updatedAt.toISOString() });
    this.unsubscribe?.();
    this.unsubscribe = this.events.subscribe((event) => {
      if (event.type === 'task.updated') {
        for (const botId of this.doing.take(event.task)) this.publishSoon(botId);
      } else if (event.type === 'bot.deleted') {
        this.doing.forget(event.botId);
        this.published.delete(event.botId);
      }
    });
  }

  /** Tells everyone how the bot is now (what it does included). */
  publish(row: BotRow): Bot {
    const bot = this.toBot(row);
    clearTimeout(this.pending.get(row.id));
    this.pending.delete(row.id);
    this.published.set(row.id, liveKey(bot));
    this.events.publish({ type: 'bot.updated', bot });
    return bot;
  }

  /** What the bot does changed: said once things settle, as it is then (if still news). */
  private publishSoon(botId: string): void {
    if (this.pending.has(botId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(botId);
      void this.row(botId).then(
        (row) => {
          if (this.published.get(botId) !== liveKey(this.toBot(row))) this.publish(row);
        },
        () => undefined, // Deleted meanwhile, or the hub is closing.
      );
    }, this.publishDelayMs);
    timer.unref();
    this.pending.set(botId, timer);
  }

  /** The hub stops: nothing more goes out. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  async list(): Promise<Bot[]> {
    const rows = await this.db.select().from(bots).orderBy(bots.createdAt);
    return rows.map((row) => this.toBot(row));
  }

  async row(id: string): Promise<BotRow> {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, id));
    if (!row) throw notFound('Bot not found');
    return row;
  }

  /** The Chef (null before the organisation exists). */
  async chef(): Promise<BotRow | null> {
    const [row] = await this.db.select().from(bots).where(eq(bots.isChef, true));
    return row ?? null;
  }

  /**
   * A renamed bot keeps its workspace folder: `bots/<old>` moves to `bots/<new>` (unless that
   * one exists) and the screenshots shown in its conversation follow.
   */
  async moveFolder(row: BotRow, newName: string, files: WorkspaceFiles): Promise<void> {
    const from = botFolder(row.name);
    const to = botFolder(newName);
    if (from === to || !row.workspaceId) return;
    try {
      await files.move(row.workspaceId, from, to);
    } catch {
      return; // No folder yet, or the new name's folder is taken: each keeps its own.
    }
    const rows = await this.db
      .select({ id: messages.id, parts: messages.parts })
      .from(messages)
      .where(eq(messages.botId, row.id));
    for (const message of rows) {
      let moved = false;
      const parts = message.parts.map((part): MessagePart => {
        if (part.type !== 'tool' || !part.image?.path.startsWith(`${from}/`)) return part;
        moved = true;
        return { ...part, image: { ...part.image, path: to + part.image.path.slice(from.length) } };
      });
      if (moved) await this.db.update(messages).set({ parts }).where(eq(messages.id, message.id));
    }
    this.events.publish({
      type: 'workspace.changed',
      workspaceId: row.workspaceId,
      paths: ['bots'],
    });
  }

  async update(id: string, values: BotUpdate | Partial<BotRow>): Promise<Bot> {
    const [row] = await this.db.update(bots).set(values).where(eq(bots.id, id)).returning();
    if (!row) throw notFound('Bot not found');
    return this.publish(row);
  }
}
