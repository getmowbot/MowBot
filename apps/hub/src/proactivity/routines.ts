import { randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  Routine,
  RoutineKind,
  RoutineRun,
  RoutineRunStatus,
  RoutineTrigger,
  RoutineUpdate,
} from '@mowbot/contract';
import { and, count, desc, eq, lte } from 'drizzle-orm';
import type { BotRow } from '../bots/service';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { routineRuns, routines } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { nextRun, triggerProblem } from './schedule';

export const MAX_ROUTINES_PER_BOT = 20;
/** After this many failures in a row, a routine is switched off. */
export const MAX_FAILURES = 3;
const WEBHOOK_PURPOSE = 'routine-webhook';
const RUNS_KEPT = 20;

export type RoutineRow = typeof routines.$inferSelect;
type RunRow = typeof routineRuns.$inferSelect;

export const HEARTBEAT_PROMPT =
  "Réveil périodique. Fais le point sur ta mission, tes tâches en cours (list_tasks) et ce qui t'attend. S'il y a quelque chose d'utile à faire maintenant, fais-le (et crée une routine si ça doit revenir). Sinon, réponds seulement « RAS », sans outil.";

export const DIGEST_PROMPT =
  "Bilan de la journée pour l'utilisateur : appelle activity_report, puis envoie-lui un résumé court et utile avec notify_user (titre « Bilan du jour », priorité normal) : ce que chaque équipe et chaque bot solo a fait, ce qui est terminé, ce qui bloque. S'il ne s'est rien passé, réponds « RAS » sans rien envoyer.";

/** An idle check-in answer: the exchange is tidied away. */
export const IDLE_ANSWER = /^\s*RAS[\s.!]*$/i;

export function toRun(row: RunRow): RoutineRun {
  return {
    id: row.id,
    routineId: row.routineId,
    status: row.status,
    detail: row.detail,
    messageId: row.messageId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Routines: scheduled or event-driven work bots (or the user) set up for themselves. */
export class RoutineService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly masterKey: Buffer,
    readonly timeZone: string,
  ) {}

  toRoutine(row: RoutineRow): Routine {
    const token = row.webhookTokenSealed
      ? open(this.masterKey, WEBHOOK_PURPOSE, row.webhookTokenSealed)
      : null;
    return {
      id: row.id,
      botId: row.botId,
      kind: row.kind,
      name: row.name,
      prompt: row.prompt,
      trigger: row.trigger,
      enabled: row.enabled,
      silent: row.silent,
      createdBy: row.createdBy,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      lastStatus: row.lastStatus,
      failures: row.failures,
      webhookUrl: token ? `/api/v1/hooks/routines/${row.id}/${token}` : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(botId?: string): Promise<RoutineRow[]> {
    return this.db
      .select()
      .from(routines)
      .where(botId ? eq(routines.botId, botId) : undefined)
      .orderBy(routines.createdAt);
  }

  async row(id: string): Promise<RoutineRow> {
    const [row] = await this.db.select().from(routines).where(eq(routines.id, id));
    if (!row) throw notFound('Routine not found');
    return row;
  }

  private check(trigger: RoutineTrigger): void {
    const problem = triggerProblem(trigger, new Date(), this.timeZone);
    if (problem) throw new HttpProblem(400, 'invalid_trigger', problem);
  }

  private publish(row: RoutineRow): Routine {
    const routine = this.toRoutine(row);
    this.events.publish({ type: 'routine.updated', routine });
    return routine;
  }

  async create(
    input: {
      botId: string;
      name: string;
      prompt: string;
      trigger: RoutineTrigger;
      silent?: boolean;
    },
    createdBy: RoutineRow['createdBy'],
    kind: RoutineKind = 'custom',
  ): Promise<Routine> {
    this.check(input.trigger);
    if (kind === 'custom') {
      const [{ total = 0 } = {}] = await this.db
        .select({ total: count() })
        .from(routines)
        .where(and(eq(routines.botId, input.botId), eq(routines.kind, 'custom')));
      if (total >= MAX_ROUTINES_PER_BOT) {
        throw new HttpProblem(
          409,
          'too_many_routines',
          `Un bot a au plus ${MAX_ROUTINES_PER_BOT} routines : supprime celles qui ne servent plus.`,
        );
      }
    }
    const [row] = await this.db
      .insert(routines)
      .values({
        botId: input.botId,
        kind,
        name: input.name,
        prompt: input.prompt,
        trigger: input.trigger,
        silent: input.silent ?? true,
        createdBy,
        nextRunAt: nextRun(input.trigger, new Date(), this.timeZone),
        webhookTokenSealed:
          input.trigger.type === 'webhook'
            ? seal(this.masterKey, WEBHOOK_PURPOSE, randomBytes(24).toString('base64url'))
            : null,
      })
      .returning();
    if (!row) throw new Error('Routine insert returned no row');
    return this.publish(row);
  }

  async update(id: string, input: RoutineUpdate): Promise<Routine> {
    const before = await this.row(id);
    if (input.trigger) this.check(input.trigger);
    const trigger = input.trigger ?? before.trigger;
    const enabled = input.enabled ?? before.enabled;
    const reschedule = input.trigger !== undefined || (input.enabled && !before.enabled);
    const [row] = await this.db
      .update(routines)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.silent !== undefined ? { silent: input.silent } : {}),
        trigger,
        enabled,
        ...(reschedule ? { nextRunAt: nextRun(trigger, new Date(), this.timeZone) } : {}),
        // Switched back on: a fresh start.
        ...(input.enabled && !before.enabled ? { failures: 0 } : {}),
        ...(trigger.type === 'webhook' && !before.webhookTokenSealed
          ? {
              webhookTokenSealed: seal(
                this.masterKey,
                WEBHOOK_PURPOSE,
                randomBytes(24).toString('base64url'),
              ),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(routines.id, id))
      .returning();
    if (!row) throw notFound('Routine not found');
    return this.publish(row);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(routines).where(eq(routines.id, id));
    this.events.publish({ type: 'routine.deleted', routineId: id });
  }

  /** Keeps the bot's check-in routine in line with its heartbeat setting. */
  async syncHeartbeat(bot: BotRow): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(routines)
      .where(and(eq(routines.botId, bot.id), eq(routines.kind, 'heartbeat')));
    if (!bot.heartbeatMinutes) {
      if (existing) await this.remove(existing.id);
      return;
    }
    const trigger: RoutineTrigger = { type: 'interval', minutes: bot.heartbeatMinutes };
    if (existing) {
      await this.update(existing.id, { trigger, enabled: true });
      return;
    }
    await this.create(
      { botId: bot.id, name: 'Réveil périodique', prompt: HEARTBEAT_PROMPT, trigger },
      'system',
      'heartbeat',
    );
  }

  /** The Chef's end-of-day summary for the user (created once; the user may switch it off). */
  async ensureDigest(chef: BotRow): Promise<void> {
    const [existing] = await this.db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.botId, chef.id), eq(routines.kind, 'digest')));
    if (existing) return;
    await this.create(
      {
        botId: chef.id,
        name: 'Bilan du jour',
        prompt: DIGEST_PROMPT,
        trigger: { type: 'cron', expr: '0 19 * * *' },
      },
      'system',
      'digest',
    );
  }

  async due(now: Date): Promise<RoutineRow[]> {
    return this.db
      .select()
      .from(routines)
      .where(and(eq(routines.enabled, true), lte(routines.nextRunAt, now)));
  }

  async runs(routineId: string): Promise<RoutineRun[]> {
    const rows = await this.db
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.startedAt))
      .limit(RUNS_KEPT);
    return rows.map(toRun);
  }

  async runningRun(routineId: string): Promise<RunRow | undefined> {
    const [row] = await this.db
      .select()
      .from(routineRuns)
      .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.status, 'running')));
    return row;
  }

  /** Records a run and moves the routine to its next occurrence. */
  async startRun(
    routine: RoutineRow,
    status: RoutineRunStatus,
    detail: string | null = null,
    now = new Date(),
  ): Promise<RunRow> {
    const finished = status !== 'running';
    const [run] = await this.db
      .insert(routineRuns)
      .values({
        routineId: routine.id,
        status,
        detail,
        startedAt: now,
        finishedAt: finished ? now : null,
      })
      .returning();
    if (!run) throw new Error('Run insert returned no row');
    const next = nextRun(routine.trigger, now, this.timeZone);
    const [row] = await this.db
      .update(routines)
      .set({
        nextRunAt: next,
        lastRunAt: now,
        lastStatus: status,
        // A `once` routine is done after it fired.
        ...(routine.trigger.type === 'once' && status !== 'skipped' ? { enabled: false } : {}),
      })
      .where(eq(routines.id, routine.id))
      .returning();
    if (row) this.publish(row);
    await this.prune(routine.id);
    return run;
  }

  /**
   * Closes a run. Failures count up (a run that was skipped or interrupted does not count);
   * returns the routine when this failure switched it off.
   */
  async finishRun(
    runId: string,
    status: RoutineRunStatus,
    extra: { detail?: string | null; messageId?: string | null } = {},
  ): Promise<{ routine: RoutineRow; disabled: boolean } | null> {
    const [run] = await this.db
      .update(routineRuns)
      .set({
        status,
        finishedAt: new Date(),
        ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
        ...(extra.messageId !== undefined ? { messageId: extra.messageId } : {}),
      })
      .where(eq(routineRuns.id, runId))
      .returning();
    if (!run) return null;
    const before = await this.row(run.routineId).catch(() => null);
    if (!before) return null;
    const failures =
      status === 'error' ? before.failures + 1 : status === 'skipped' ? before.failures : 0;
    const disabled = failures >= MAX_FAILURES && before.enabled;
    const [row] = await this.db
      .update(routines)
      .set({ lastStatus: status, failures, ...(disabled ? { enabled: false } : {}) })
      .where(eq(routines.id, before.id))
      .returning();
    if (!row) return null;
    this.publish(row);
    return { routine: row, disabled };
  }

  /** The routine whose webhook this is, when the token matches. */
  async verifyWebhook(id: string, token: string): Promise<RoutineRow | null> {
    const [row] = await this.db.select().from(routines).where(eq(routines.id, id));
    if (!row?.webhookTokenSealed || row.trigger.type !== 'webhook') return null;
    const expected = Buffer.from(open(this.masterKey, WEBHOOK_PURPOSE, row.webhookTokenSealed));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given) ? row : null;
  }

  private async prune(routineId: string): Promise<void> {
    const old = await this.db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(desc(routineRuns.startedAt))
      .offset(RUNS_KEPT);
    for (const run of old) await this.db.delete(routineRuns).where(eq(routineRuns.id, run.id));
  }
}
