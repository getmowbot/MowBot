import type { Notification, NotificationPriority, SystemSettings } from '@mowbot/contract';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { messages, notifications, settings } from '../db/schema';
import type { EventBus } from '../events';
import type { PushKind, PushService } from '../push/service';
import { startOfDay } from './schedule';

type NotificationRow = typeof notifications.$inferSelect;

export function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    botId: row.botId,
    priority: row.priority,
    title: row.title,
    body: row.body,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What bots (and the hub) tell the user. Digest-level ones wait for the daily summary. */
export class NotificationService {
  private push: PushService | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  /** Urgent and normal notifications also reach the user's phones. */
  setPush(push: PushService): void {
    this.push = push;
  }

  /** `push`: what kind of phone notification it makes (digests make none). */
  async create(input: {
    botId: string | null;
    priority: NotificationPriority;
    title: string;
    body?: string | null;
    push?: PushKind;
  }): Promise<Notification> {
    const [row] = await this.db
      .insert(notifications)
      .values({
        botId: input.botId,
        priority: input.priority,
        title: input.title,
        body: input.body ?? null,
      })
      .returning();
    if (!row) throw new Error('Notification insert returned no row');
    const notification = toNotification(row);
    this.events.publish({ type: 'notification.created', notification });
    if (input.priority !== 'digest') {
      this.push?.notify({
        kind: input.push ?? 'notification',
        botId: input.botId,
        title: input.title,
        body: input.body,
        urgent: input.priority === 'urgent',
      });
    }
    return notification;
  }

  /** Newest first; `unread` leaves out digest-level ones (they don't call for attention). */
  async list(limit = 100): Promise<{ items: Notification[]; unread: number }> {
    const rows = await this.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const [{ unread = 0 } = {}] = await this.db
      .select({ unread: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(isNull(notifications.readAt), ne(notifications.priority, 'digest')));
    return { items: rows.map(toNotification), unread };
  }

  /** Deletes them all. */
  async clear(): Promise<void> {
    await this.db.delete(notifications);
    this.events.publish({ type: 'notifications.cleared' });
  }

  async markRead(ids?: string[]): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined));
  }
}

const SYSTEM_KEY = 'system';

const DEFAULTS: Omit<SystemSettings, 'timeZone'> = {
  paused: false,
  quietHours: { start: '22:00', end: '07:00' },
  dailyTokenBudget: null,
};

/** Instance-wide proactivity settings: the kill switch, quiet hours, the global budget. */
export class SystemService {
  private cache: SystemSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    readonly timeZone: string,
  ) {}

  async get(): Promise<SystemSettings> {
    if (this.cache) return this.cache;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SYSTEM_KEY));
    const stored = (row?.value ?? {}) as Partial<SystemSettings>;
    this.cache = { ...DEFAULTS, ...stored, timeZone: this.timeZone };
    return this.cache;
  }

  async update(patch: Partial<Omit<SystemSettings, 'timeZone'>>): Promise<SystemSettings> {
    const { timeZone: _, ...current } = await this.get();
    const value = { ...current, ...patch };
    await this.db
      .insert(settings)
      .values({ key: SYSTEM_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    this.cache = { ...value, timeZone: this.timeZone };
    this.events.publish({ type: 'system.updated', settings: this.cache });
    return this.cache;
  }

  /** Tokens spent today on what bots did on their own (all bots, or one). */
  async autonomousTokensToday(botId?: string): Promise<number> {
    const since = startOfDay(new Date(), this.timeZone);
    const [row] = await this.db
      .select({
        total: sql<number>`coalesce(sum(coalesce((${messages.usage}->>'inputTokens')::int, 0) + coalesce((${messages.usage}->>'outputTokens')::int, 0)), 0)::int`,
      })
      .from(messages)
      .where(
        and(
          sql`${messages.createdAt} >= ${since}`,
          sql`(${messages.meta}->>'autonomous')::boolean is true`,
          botId ? eq(messages.botId, botId) : undefined,
        ),
      );
    return row?.total ?? 0;
  }
}
