import type { Task, TaskStatus, TaskUpdate } from '@mowbot/contract';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bots, settings, tasks } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { HUB_TEXTS, ownerLocale } from '../i18n';
import type { PlanService } from './plans';

type TaskRow = typeof tasks.$inferSelect;
type BotRow = typeof bots.$inferSelect;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    status: row.status,
    result: row.result,
    assigneeBotId: row.assigneeBotId,
    creatorBotId: row.creatorBotId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'à faire',
  doing: 'en cours',
  blocked: 'bloquée',
  done: 'terminée',
  cancelled: 'annulée',
};

/** Tells a bot about a task (assigned to it, or one it gave that moved). Wakes it up. */
export type TaskNotifier = (input: {
  to: BotRow;
  from: BotRow | null;
  task: TaskRow;
  text: string;
  display: string;
  /** The notice in a few words, as the apps show it folded. */
  summary: string;
  /** Bot-to-bot hops behind this notice (loop guard). */
  depth: number;
}) => Promise<void>;

const ACTIVITY_KEY = 'activity';

/** Tasks bots give each other (or the user gives them), with their status and result. */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly notify: TaskNotifier,
    /** The teams' plans: a task can carry a step, which then follows it. */
    private readonly plans?: PlanService,
  ) {}

  async list(filter: { botId?: string; status?: TaskStatus } = {}): Promise<Task[]> {
    const where: SQL[] = [];
    if (filter.botId) where.push(eq(tasks.assigneeBotId, filter.botId));
    if (filter.status) where.push(eq(tasks.status, filter.status));
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...where))
      .orderBy(desc(tasks.updatedAt))
      .limit(200);
    return rows.map(toTask);
  }

  async row(id: string): Promise<TaskRow> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    if (!row) throw notFound('Task not found');
    return row;
  }

  /**
   * `creator` null: the user. `step`: the step of a team's plan the task carries (it goes to
   * the assignee and follows the task), checked before the task is made.
   */
  async create(
    input: {
      assignee: BotRow;
      title: string;
      details?: string | null;
      step?: { teamId: string; number: number };
    },
    creator: BotRow | null,
    depth = 0,
  ): Promise<Task> {
    const { step } = input;
    if (step) await this.plans?.step(step.teamId, step.number);
    const [row] = await this.db
      .insert(tasks)
      .values({
        title: input.title,
        details: input.details ?? null,
        assigneeBotId: input.assignee.id,
        creatorBotId: creator?.id ?? null,
      })
      .returning();
    if (!row) throw new Error('Task insert returned no row');
    this.events.publish({ type: 'task.updated', task: toTask(row) });
    // Before the assignee wakes up: it reads the step as its own.
    if (step) await this.plans?.attach(step.teamId, step.number, row);
    await this.notify({
      to: input.assignee,
      from: creator,
      task: row,
      depth,
      summary: row.title,
      display: [`**${HUB_TEXTS[await ownerLocale(this.db)].task}** · ${row.title}`, row.details]
        .filter(Boolean)
        .join('\n\n'),
      text: [
        `Nouvelle tâche (id ${row.id}) : « ${row.title} »`,
        row.details,
        "Quand tu as fini, ou si tu es bloqué, appelle update_task avec cet id, le statut et le résultat (c'est ce que l'auteur de la tâche lira).",
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return toTask(row);
  }

  /**
   * `actor` null: the user. A bot may update the tasks it was given or gave (the Chef: all).
   * When the status changes, the other side hears about it.
   */
  async update(id: string, input: TaskUpdate, actor: BotRow | null, depth = 0): Promise<Task> {
    const before = await this.row(id);
    if (
      actor &&
      !actor.isChef &&
      actor.id !== before.assigneeBotId &&
      actor.id !== before.creatorBotId
    ) {
      throw new HttpProblem(403, 'not_your_task', "Cette tâche n'est ni à toi ni de toi.");
    }
    const [row] = await this.db
      .update(tasks)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.details !== undefined ? { details: input.details } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id))
      .returning();
    if (!row) throw notFound('Task not found');
    this.events.publish({ type: 'task.updated', task: toTask(row) });

    if (input.status && input.status !== before.status) {
      await this.plans?.followTask(row);
      // Whoever did not make the change hears about it: the creator when the assignee reports,
      // the assignee when someone else (the creator, the Chef, the user) moves its task.
      const otherId = actor?.id === row.assigneeBotId ? row.creatorBotId : row.assigneeBotId;
      const [other] = otherId ? await this.db.select().from(bots).where(eq(bots.id, otherId)) : [];
      if (other && other.id !== actor?.id) {
        const status = TASK_STATUS_LABELS[row.status];
        const texts = HUB_TEXTS[await ownerLocale(this.db)];
        await this.notify({
          to: other,
          from: actor,
          task: row,
          depth,
          summary: `${capitalize(texts.taskStatus[row.status])} · ${row.title}`,
          display: [`**${texts.task} ${texts.taskStatus[row.status]}** · ${row.title}`, row.result]
            .filter(Boolean)
            .join('\n\n'),
          text: [
            `La tâche « ${row.title} » (id ${row.id}) est maintenant ${status}.`,
            row.result ? `Résultat : ${row.result}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }
    }
    return toTask(row);
  }

  /** Where the activity feed starts since the user last cleared it (null: never cleared). */
  async feedStart(): Promise<Date | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, ACTIVITY_KEY));
    const clearedAt = (row?.value as { clearedAt?: string } | undefined)?.clearedAt;
    return clearedAt ? new Date(clearedAt) : null;
  }

  /**
   * The user clears the activity tab: finished tasks go away, the feed starts over. Messages
   * between bots stay in their conversations (they are the bots' memory).
   */
  async clearActivity(now = new Date()): Promise<void> {
    await this.db.delete(tasks).where(inArray(tasks.status, ['done', 'cancelled']));
    const value = { clearedAt: now.toISOString() };
    await this.db
      .insert(settings)
      .values({ key: ACTIVITY_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
    this.events.publish({ type: 'activity.cleared' });
  }
}
