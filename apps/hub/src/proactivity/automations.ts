import type { Automation, AutomationOutcome, AutomationStop } from '@mowbot/contract';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { contentSchema, toContent } from '../agents/canvas-tools';
import type { BotRuntime } from '../agents/runtime';
import type { BotRow } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { ComputerService, Logger } from '../computers/service';
import type { Db } from '../db/client';
import { automations, bots } from '../db/schema';
import type { EventBus } from '../events';
import { notFound } from '../http/problems';
import { hubTexts } from '../i18n';
import type { VaultService } from '../vault/service';
import type { CanvasService } from './canvases';
import type { NotificationService, SystemService } from './notifications';

export type AutomationRow = typeof automations.$inferSelect;

export const MAX_AUTOMATIONS_PER_BOT = 5;
export const MIN_INTERVAL_SECONDS = 15;
/** After this many failed runs in a row, an automation pauses and its bot is told. */
export const MAX_AUTOMATION_FAILURES = 3;
const TICK_MS = 5_000;
const RUN_TIMEOUT_MS = 60_000;
const MAX_DETAIL = 400;

/**
 * What a run prints (the last line of stdout that is a JSON object): a new content for the
 * canvas, a notification for the user, a message that wakes the bot, or the end.
 */
export const automationOutputSchema = z.object({
  canvas: z
    .object({ title: z.string().min(1).max(60).optional(), content: contentSchema })
    .optional(),
  notify: z
    .object({
      title: z.string().min(1).max(120),
      body: z.string().max(500).optional(),
      priority: z.enum(['urgent', 'normal']).default('normal'),
    })
    .optional(),
  wake: z.string().min(1).max(2_000).optional(),
  /** true, or why it is over ("Match terminé"). */
  done: z.union([z.boolean(), z.string().max(200)]).optional(),
});
export type AutomationOutput = z.infer<typeof automationOutputSchema>;

/** The last line of stdout that parses as a JSON object, or the whole output. */
export function parseOutput(stdout: string): AutomationOutput {
  const lines = stdout.trim().split('\n').reverse();
  for (const candidate of [...lines, stdout]) {
    const text = candidate.trim();
    if (!text.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = automationOutputSchema.safeParse(json);
    if (parsed.success) return parsed.data;
    throw new RunError(
      'output',
      `${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
        .join(' ; ')}`,
    );
  }
  throw new RunError('output', 'no JSON object on the last line');
}

/** Why a run failed, as the apps word it (`detail` is the script's own output). */
export class RunError extends Error {
  constructor(
    readonly kind: NonNullable<AutomationOutcome['error']>['kind'],
    readonly detail: string,
    readonly code: number | null = null,
  ) {
    super(detail);
  }
}

const toRunError = (error: unknown): RunError =>
  error instanceof RunError
    ? error
    : new RunError('other', (error as Error).message.slice(0, MAX_DETAIL));

const ERRORS: Record<NonNullable<AutomationOutcome['error']>['kind'], string> = {
  exit: 'le script a échoué',
  timeout: 'le script a dépassé le temps permis',
  output: 'sa sortie JSON est invalide',
  no_canvas: "il n'a pas de canvas à mettre à jour",
  no_computer: "le bot n'a plus d'ordinateur",
  other: 'erreur',
};

/** What a run did, for the bot (in French, like the bots' other tool results). */
export function describeOutcome(outcome: AutomationOutcome): string {
  if (outcome.error) {
    const { kind, code, detail } = outcome.error;
    return `Échec : ${ERRORS[kind]}${code !== null ? ` (code ${code})` : ''} — ${detail}`;
  }
  const did = { canvas: 'canvas mis à jour', notify: 'utilisateur prévenu', wake: 'bot réveillé' };
  return outcome.actions.map((action) => did[action]).join(', ') || 'rien à faire';
}

export function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    command: row.command,
    intervalSeconds: row.intervalSeconds,
    canvasId: row.canvasId,
    until: row.until?.toISOString() ?? null,
    status: row.status,
    runs: row.runs,
    failures: row.failures,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastOutcome: row.lastOutcome ?? null,
    stop: row.stop ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface AutomationDeps {
  db: Db;
  events: EventBus;
  canvases: CanvasService;
  notifications: NotificationService;
  computers: ComputerService;
  system: SystemService;
  vault: VaultService;
}

/**
 * Runs bots' automations: their script on their computer, at their pace, and acts on what it
 * prints, without a model. Nothing runs while the instance is paused.
 */
export class AutomationService {
  private log: Logger = { warn: () => {}, error: () => {} };
  private runtime: BotRuntime | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();

  constructor(private readonly deps: AutomationDeps) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  /** To wake bots and leave them notes (the runtime is built after this service). */
  setRuntime(runtime: BotRuntime): void {
    this.runtime = runtime;
  }

  private publish(row: AutomationRow): Automation {
    const automation = toAutomation(row);
    this.deps.events.publish({ type: 'automation.updated', automation });
    return automation;
  }

  async list(botId?: string): Promise<AutomationRow[]> {
    return this.deps.db
      .select()
      .from(automations)
      .where(botId ? eq(automations.botId, botId) : undefined)
      .orderBy(asc(automations.createdAt));
  }

  async row(id: string): Promise<AutomationRow> {
    const [row] = await this.deps.db.select().from(automations).where(eq(automations.id, id));
    if (!row) throw notFound('Automation not found');
    return row;
  }

  /** A bot's automation by its name or id. */
  async find(botId: string, ref: string): Promise<AutomationRow> {
    const value = ref.trim();
    const mine = await this.list(botId);
    const found =
      mine.find((a) => a.id === value) ??
      mine.find((a) => a.name.toLowerCase() === value.toLowerCase());
    if (!found) throw new Error(`Aucune automatisation « ${ref} » (automation_list).`);
    return found;
  }

  async create(
    bot: BotRow,
    input: {
      name: string;
      command: string;
      intervalSeconds: number;
      canvasKey?: string;
      until?: Date | null;
    },
  ): Promise<AutomationRow> {
    if (!bot.computerId) throw new Error("Une automatisation tourne sur ton PC : tu n'en as pas.");
    const [{ active = 0 } = {}] = await this.deps.db
      .select({ active: count() })
      .from(automations)
      .where(and(eq(automations.botId, bot.id), eq(automations.status, 'active')));
    if (active >= MAX_AUTOMATIONS_PER_BOT) {
      throw new Error(
        `Tu as déjà ${MAX_AUTOMATIONS_PER_BOT} automatisations actives : arrête-en une (automation_delete).`,
      );
    }
    let canvasId: string | null = null;
    if (input.canvasKey) {
      const canvas = await this.deps.canvases.byKey(bot.id, input.canvasKey);
      if (!canvas) {
        throw new Error(
          `Aucun canvas « ${input.canvasKey} » : une automatisation met à jour un canvas que tu as déjà épinglé (avec l'accord de l'utilisateur).`,
        );
      }
      canvasId = canvas.id;
    }
    const [row] = await this.deps.db
      .insert(automations)
      .values({
        botId: bot.id,
        name: input.name,
        command: input.command,
        intervalSeconds: input.intervalSeconds,
        canvasId,
        until: input.until ?? null,
      })
      .returning();
    if (!row) throw new Error('Automation insert returned no row');
    this.publish(row);
    return row;
  }

  async update(
    id: string,
    patch: Partial<Pick<AutomationRow, 'command' | 'intervalSeconds' | 'until' | 'status'>>,
  ): Promise<AutomationRow> {
    const reset = patch.status === 'active' || patch.command !== undefined;
    const [row] = await this.deps.db
      .update(automations)
      .set({
        ...patch,
        ...(reset ? { failures: 0, stop: null } : {}),
      })
      .where(eq(automations.id, id))
      .returning();
    if (!row) throw notFound('Automation not found');
    this.publish(row);
    return row;
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.deps.db.delete(automations).where(eq(automations.id, id));
    this.deps.events.publish({ type: 'automation.deleted', automationId: id });
  }

  start(intervalMs = TICK_MS): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs what is due (each automation one run at a time). */
  async tick(now = new Date()): Promise<void> {
    try {
      if ((await this.deps.system.get()).paused) return;
      await this.prune(now);
      const active = await this.deps.db
        .select()
        .from(automations)
        .where(eq(automations.status, 'active'));
      for (const row of active) {
        if (this.running.has(row.id)) continue;
        if (row.until && row.until <= now) {
          await this.finish(row, { reason: 'deadline', detail: null });
          continue;
        }
        const due =
          !row.lastRunAt || row.lastRunAt.getTime() + row.intervalSeconds * 1000 <= now.getTime();
        if (due) void this.run(row.id);
      }
    } catch (error) {
      this.log.error({ err: error }, 'Automation tick failed');
    }
  }

  /** The bot's computer, started if it slept. */
  private async agent(computerId: string): Promise<AgentClient> {
    const { computers } = this.deps;
    const pc = await computers.get(computerId);
    if (pc.status !== 'running') {
      await computers.start(computerId);
      await computers.waitForBoot(computerId);
    }
    void computers.touch(computerId);
    return computers.agentFor(computerId);
  }

  /** One run: the script, then what it asked for. Returns what happened, for the bot. */
  async run(id: string): Promise<string> {
    if (this.running.has(id)) return 'Un passage est déjà en cours.';
    this.running.add(id);
    const row = await this.row(id);
    try {
      const [bot] = await this.deps.db.select().from(bots).where(eq(bots.id, row.botId));
      if (!bot?.computerId) throw new RunError('no_computer', "Le bot n'a plus d'ordinateur.");
      const agent = await this.agent(bot.computerId);
      const secrets = await this.deps.vault.scope(bot);
      const script = [
        `export MOWBOT_BOT=${bot.id}`,
        `export MOWBOT_AUTOMATION=${row.id}`,
        'cd /workspace',
        await secrets.expand(row.command),
      ].join('\n');
      const result = await agent.exec(script, { timeoutMs: RUN_TIMEOUT_MS });
      if (result.timedOut) throw new RunError('timeout', `${RUN_TIMEOUT_MS / 1000} s`);
      if (result.exitCode !== 0) {
        throw new RunError(
          'exit',
          secrets.mask((result.stderr || result.stdout).trim().slice(-MAX_DETAIL)),
          result.exitCode,
        );
      }
      const output = parseOutput(result.stdout);
      const actions: AutomationOutcome['actions'] = [];
      if (output.canvas) {
        if (!row.canvasId) throw new RunError('no_canvas', 'canvas');
        const canvas = await this.deps.canvases.row(row.canvasId);
        await this.deps.canvases.publishFromBot(bot.id, {
          key: canvas.key,
          title: output.canvas.title ?? canvas.title,
          content: toContent(output.canvas.content, canvas.content),
        });
        actions.push('canvas');
      }
      if (output.notify) {
        await this.deps.notifications.create({
          botId: bot.id,
          priority: output.notify.priority,
          title: output.notify.title,
          body: output.notify.body,
        });
        actions.push('notify');
      }
      if (output.wake) {
        await this.runtime?.deliver(bot.id, {
          from: null,
          kind: 'routine',
          text: `[Automatisation « ${row.name} »]\n${output.wake}`,
          display: (await hubTexts(this.deps.db)).automationWoke(row.name, output.wake),
        });
        actions.push('wake');
      }
      const outcome: AutomationOutcome = { ok: true, actions, error: null };
      const [ran] = await this.deps.db
        .update(automations)
        .set({ runs: row.runs + 1, failures: 0, lastRunAt: new Date(), lastOutcome: outcome })
        .where(eq(automations.id, row.id))
        .returning();
      const summary = describeOutcome(outcome);
      if (!ran) return summary;
      if (output.done) {
        await this.finish(ran, {
          reason: 'done',
          detail: typeof output.done === 'string' ? output.done : null,
        });
        return `${summary} ; terminée`;
      }
      this.publish(ran);
      return summary;
    } catch (error) {
      return this.failed(row, toRunError(error));
    } finally {
      this.running.delete(id);
    }
  }

  private async failed(row: AutomationRow, error: RunError): Promise<string> {
    const failures = row.failures + 1;
    const pause = failures >= MAX_AUTOMATION_FAILURES;
    const outcome: AutomationOutcome = {
      ok: false,
      actions: [],
      error: { kind: error.kind, code: error.code, detail: error.detail },
    };
    const [updated] = await this.deps.db
      .update(automations)
      .set({
        failures,
        lastRunAt: new Date(),
        lastOutcome: outcome,
        ...(pause
          ? {
              status: 'paused' as const,
              stop: { reason: 'failures' as const, detail: String(failures) },
            }
          : {}),
      })
      .where(eq(automations.id, row.id))
      .returning();
    if (updated) this.publish(updated);
    const message = describeOutcome(outcome);
    if (pause) {
      // The bot fixes its script (automation_update) or deletes it.
      await this.runtime?.deliver(row.botId, {
        from: null,
        kind: 'routine',
        text: `[Automatisation « ${row.name} » en pause après ${failures} échecs]\nDernière erreur : ${message}\nCorrige le script (automation_update, qui la relance) ou supprime-la (automation_delete).`,
        display: (await hubTexts(this.deps.db)).automationPaused(row.name, failures),
      });
    }
    return message;
  }

  /** Over: it stays listed as stopped, and the bot keeps a note for its next turn. */
  private async finish(row: AutomationRow, stop: AutomationStop): Promise<void> {
    const [updated] = await this.deps.db
      .update(automations)
      .set({ status: 'stopped', stop })
      .where(eq(automations.id, row.id))
      .returning();
    if (updated) this.publish(updated);
    const texts = await hubTexts(this.deps.db);
    const why =
      stop.detail ??
      (stop.reason === 'deadline' ? texts.automationDeadline : texts.automationFinished);
    await this.runtime?.note(
      row.botId,
      `[Automatisation « ${row.name} » terminée : ${stop.detail ?? (stop.reason === 'deadline' ? 'échéance atteinte' : 'terminée')}]`,
      texts.automationDone(row.name, why),
    );
  }

  /** Kept for a day after they stop, then forgotten. */
  async prune(now = new Date()): Promise<void> {
    const stopped = await this.deps.db
      .select()
      .from(automations)
      .where(eq(automations.status, 'stopped'));
    for (const row of stopped) {
      const since = row.lastRunAt ?? row.createdAt;
      if (now.getTime() - since.getTime() > 24 * 3600_000) await this.remove(row.id);
    }
  }
}
