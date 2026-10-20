import { randomUUID } from 'node:crypto';
import type { Message, MessageKind, MessagePart, ModelRef } from '@mowbot/contract';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { type BotRow, type BotService, toMessage } from '../bots/service';
import type { AgentClient, ExecResult } from '../computers/agent-client';
import type { ComputerService, Logger } from '../computers/service';
import type { Db } from '../db/client';
import { bots, type MessageMeta, messages, owner, routineRuns, teams } from '../db/schema';
import type { EventBus } from '../events';
import type { OrgService } from '../org/service';
import { TaskService } from '../org/tasks';
import type { CanvasService } from '../proactivity/canvases';
import type { NotificationService, SystemService } from '../proactivity/notifications';
import { IDLE_ANSWER, MAX_FAILURES, type RoutineService } from '../proactivity/routines';
import type { ProviderService } from '../providers/service';
import type { WorkspaceFiles } from '../workspaces/files';
import { buildCanvasTools } from './canvas-tools';
import { closeOpened, inventory, openedBy, rememberWindows } from './desktop';
import { buildOrgTools } from './org-tools';
import { buildProactiveTools } from './proactive-tools';
import { systemPrompt } from './prompt';
import { FileLocks, ScreenLeases } from './shared-pc';
import { buildTools, clip } from './tools';

const HISTORY_MESSAGES = 40;
const MAX_STEPS = 30;
const UI_OUTPUT_CHARS = 4_000;
/** After this long without work, what a bot left open on its computer gets closed. */
const TIDY_AFTER_MS = 10 * 60_000;
/** Bot-to-bot hops without the user before bots must stop writing to each other. */
export const MAX_DEPTH = 10;
/** Messages, questions and tasks a bot may send other bots per hour. */
const MAX_SENDS_PER_HOUR = 60;
const ASK_TIMEOUT_MS = 15 * 60_000;

type MessageRow = typeof messages.$inferSelect;

/** Written by the user (a message, or a task they gave), not by a bot or a routine. */
const fromOwner = (m: MessageRow) => !m.fromBotId && !m.meta?.fromName && m.kind !== 'routine';

export interface RuntimeDeps {
  db: Db;
  events: EventBus;
  bots: BotService;
  providers: ProviderService;
  computers: ComputerService;
  files: WorkspaceFiles;
  org: OrgService;
  routines: RoutineService;
  notifications: NotificationService;
  system: SystemService;
  canvases: CanvasService;
  /** Tests inject scripted models (several: a fallback chain). */
  modelFor?: (bot: BotRow) => LanguageModel | LanguageModel[] | null;
  tidyAfterMs?: number;
  askTimeoutMs?: number;
}

/** A message for a bot from another bot (or from the user, for tasks). Wakes the bot up. */
export interface Delivery {
  /** null: the user. */
  from: BotRow | null;
  kind: MessageKind;
  /** What the bot reads, after a header naming the sender. */
  text: string;
  /** What the app shows (defaults to `text`). */
  display?: string;
  meta?: Omit<MessageMeta, 'fromName'>;
}

interface PendingAsk {
  askerId: string;
  resolve(answer: string): void;
  /** The asker gave up waiting: the answer comes to it later as a message. */
  late: boolean;
  depth: number;
}

/** Binary payloads stay out of stored transcripts (screenshots are re-taken when needed). */
function stripBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBinary);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'image-data' || record.type === 'file-data' || record.type === 'media') {
      return { type: 'text', text: '[image retirée de l’historique]' };
    }
    return Object.fromEntries(Object.entries(record).map(([key, v]) => [key, stripBinary(v)]));
  }
  return value;
}

const textOf = (parts: MessagePart[]) =>
  parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Erreur inconnue';

/** What the UI shows for a finished tool call. */
function summarize(
  toolName: string,
  input: unknown,
  output: unknown,
  workspaceId: string | null,
): Pick<Extract<MessagePart, { type: 'tool' }>, 'output' | 'image'> {
  if (toolName === 'screenshot') {
    const saved = (output as { saved?: string | null }).saved;
    return {
      output: "Capture de l'écran",
      ...(saved && workspaceId ? { image: { workspaceId, path: saved } } : {}),
    };
  }
  if (toolName === 'bash') {
    const result = output as ExecResult;
    const command = (input as { command?: string }).command ?? '';
    const body = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return {
      output: clip(
        `$ ${command}\n${body}${result.exitCode ? `\n[exit ${result.exitCode}]` : ''}`,
        UI_OUTPUT_CHARS,
      ),
    };
  }
  return {
    output: clip(typeof output === 'string' ? output : JSON.stringify(output), UI_OUTPUT_CHARS),
  };
}

/**
 * Runs bots. Each bot has a single-flight queue: a user message schedules a run that answers
 * with a streamed LLM ↔ tools loop; text deltas and tool checkpoints are published as events.
 */
export class BotRuntime {
  private log: Logger = { warn: () => {}, error: () => {} };
  private readonly chains = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly tidyTimers = new Map<string, NodeJS.Timeout>();
  /** Questions between bots awaiting an answer, by ask id. */
  private readonly asks = new Map<string, PendingAsk>();
  /** Who waits for whom (asker → asked), to refuse questions that would deadlock. */
  private readonly waiting = new Map<string, string>();
  /** When each bot recently wrote to other bots (rate limit). */
  private readonly sends = new Map<string, number[]>();
  readonly screen = new ScreenLeases();
  readonly locks = new FileLocks();
  readonly tasks: TaskService;

  constructor(private readonly deps: RuntimeDeps) {
    this.tasks = new TaskService(deps.db, deps.events, (notice) =>
      this.deliver(notice.to.id, {
        from: notice.from,
        kind: 'task',
        text: notice.text,
        display: notice.display,
        meta: { taskId: notice.task.id, depth: notice.depth },
      }),
    );
  }

  setLogger(log: Logger): void {
    this.log = log;
  }

  /** Puts a message in a bot's conversation and wakes it up. */
  async deliver(toBotId: string, delivery: Delivery): Promise<void> {
    const header = await this.header(delivery);
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        botId: toBotId,
        role: 'user',
        fromBotId: delivery.from?.id ?? null,
        kind: delivery.kind,
        meta: { ...delivery.meta, ...(delivery.from ? { fromName: delivery.from.name } : {}) },
        parts: [{ type: 'text', text: delivery.display ?? delivery.text }],
        modelMessages: [
          { role: 'user', content: header ? `${header}\n${delivery.text}` : delivery.text },
        ],
        status: 'done',
      })
      .returning();
    if (!row) throw new Error('Message insert returned no row');
    this.publish(row);
    // Paused: bots don't act on their own; the message waits for the resume. A task from the
    // user is the user asking, so it runs.
    const fromUser = !delivery.from && delivery.kind === 'task';
    if (!fromUser && (await this.deps.system.get()).paused) return;
    this.schedule(toBotId);
  }

  /** Kill switch: every bot stops what it is doing now. */
  pauseAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  /** Bots pick up what reached them while paused. */
  async resumeAll(): Promise<void> {
    for (const bot of await this.deps.db.select({ id: bots.id }).from(bots)) {
      const [last] = await this.deps.db
        .select({ role: messages.role })
        .from(messages)
        .where(eq(messages.botId, bot.id))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      if (last?.role === 'user' && !this.chains.has(bot.id)) this.schedule(bot.id);
    }
  }

  private async header({ from, kind }: Delivery): Promise<string> {
    // Routines write their own header (their name, how they fired).
    if (kind === 'routine') return '';
    if (!from) {
      const [account] = await this.deps.db.select({ name: owner.displayName }).from(owner);
      return `[De la part de ${account?.name ?? "l'utilisateur"}]`;
    }
    const who = await this.describe(from);
    if (kind === 'ask') {
      return `[Question de ${who}. Ta réponse finale lui est transmise telle quelle : réponds-lui directement, sans send_message.]`;
    }
    if (kind === 'task') return `[De ${who}]`;
    return `[Message de ${who}. Pour lui répondre, utilise send_message ; ne réponds pas si ce n'est pas utile.]`;
  }

  /** `Nova (Rédactrice, équipe Marketing)` */
  async describe(bot: BotRow): Promise<string> {
    const [team] = bot.teamId
      ? await this.deps.db.select({ name: teams.name }).from(teams).where(eq(teams.id, bot.teamId))
      : [];
    const where = team ? `, équipe ${team.name}` : bot.isChef ? '' : ', bot solo';
    return `${bot.name} (${bot.role}${where})`;
  }

  /**
   * Whether `from` may write to `to` now: not itself, not past the hop limit, not into an
   * isolated team (except through its lead or by the Chef), not faster than the rate limit.
   */
  async checkReach(from: BotRow, to: BotRow, depth: number): Promise<void> {
    if (from.id === to.id) throw new Error("C'est toi.");
    if (depth > MAX_DEPTH) {
      throw new Error(
        "Trop d'échanges en chaîne entre bots sans l'utilisateur : termine ce que tu peux et fais le point avec l'utilisateur.",
      );
    }
    if (to.teamId && to.teamId !== from.teamId && !from.isChef) {
      const [team] = await this.deps.db.select().from(teams).where(eq(teams.id, to.teamId));
      if (team?.isolated && team.leadBotId !== to.id) {
        const [lead] = team.leadBotId
          ? await this.deps.db.select().from(bots).where(eq(bots.id, team.leadBotId))
          : [];
        throw new Error(
          `L'équipe ${team.name} est cloisonnée : passe par ${lead ? `son lead, ${lead.name}, ou ` : ''}le Chef.`,
        );
      }
    }
    const hourAgo = Date.now() - 3_600_000;
    const recent = (this.sends.get(from.id) ?? []).filter((at) => at > hourAgo);
    if (recent.length >= MAX_SENDS_PER_HOUR) {
      throw new Error(
        `Tu as déjà écrit ${MAX_SENDS_PER_HOUR} fois à d'autres bots cette heure-ci : fais une pause.`,
      );
    }
    recent.push(Date.now());
    this.sends.set(from.id, recent);
  }

  /**
   * Asks another bot and waits for its answer (the final text of the run that handles the
   * question). Refused when it would deadlock; gives up after a while (the answer then
   * arrives later as a message).
   */
  async ask(
    from: BotRow,
    to: BotRow,
    question: string,
    depth: number,
    signal?: AbortSignal,
  ): Promise<string> {
    for (let cursor: string | undefined = to.id; cursor; cursor = this.waiting.get(cursor)) {
      if (cursor === from.id) {
        throw new Error(
          `${to.name} attend déjà une réponse de toi (directement ou par d'autres bots) : écris-lui plutôt avec send_message.`,
        );
      }
    }
    await this.checkReach(from, to, depth);
    const askId = randomUUID();
    const answer = new Promise<string>((resolve) =>
      this.asks.set(askId, { askerId: from.id, resolve, late: false, depth }),
    );
    await this.deliver(to.id, { from, kind: 'ask', text: question, meta: { askId, depth } });
    this.waiting.set(from.id, to.id);
    await this.deps.bots.update(from.id, {
      status: 'waiting_bot',
      // The name of the bot it waits for; clients word it ("attend Nova", "waiting for Nova").
      statusDetail: to.name,
    });
    const timeoutMs = this.deps.askTimeoutMs ?? ASK_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        answer,
        new Promise<string>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          onAbort = () => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (signal?.aborted) {
        this.asks.delete(askId);
        throw error;
      }
      const pending = this.asks.get(askId);
      if (pending) pending.late = true;
      return `${to.name} n'a pas répondu dans les ${Math.round(timeoutMs / 60_000)} minutes. Sa réponse t'arrivera plus tard, comme un message.`;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      this.waiting.delete(from.id);
      if (!signal?.aborted) {
        await this.deps.bots.update(from.id, { status: 'working', statusDetail: null });
      }
    }
  }

  /** The run that handled these questions is over: their askers get its answer. */
  private async settleAsks(askIds: string[], bot: BotRow, answer: string): Promise<void> {
    for (const askId of askIds) {
      const pending = this.asks.get(askId);
      if (!pending) continue;
      this.asks.delete(askId);
      if (!pending.late) {
        pending.resolve(answer);
        continue;
      }
      await this.deliver(pending.askerId, {
        from: bot,
        kind: 'chat',
        text: `Réponse (en retard) à ta question :\n${answer}`,
        meta: { depth: pending.depth + 1 },
      }).catch((error) => this.log.warn({ err: error, askId }, 'Late answer lost'));
    }
  }

  /** Before deleting a bot: stop it, answer whoever waits on it. */
  async forget(botId: string): Promise<void> {
    const bot = await this.deps.bots.row(botId);
    this.stop(botId);
    await this.idle(botId);
    clearTimeout(this.tidyTimers.get(botId));
    this.tidyTimers.delete(botId);
    this.screen.releaseAll(botId);
    this.locks.releaseAll(botId);
    this.sends.delete(botId);
    // Its own questions were dropped when its run stopped; questions to it get an answer.
    await this.answerAsksOf(bot, `${bot.name} a été supprimé et ne répondra pas.`);
  }

  /** Answers every question waiting in a bot's conversation (it was cleared or deleted). */
  private async answerAsksOf(bot: BotRow, answer: string): Promise<void> {
    const rows = await this.deps.db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.botId, bot.id), eq(messages.kind, 'ask')));
    const askIds = rows.flatMap((row) => (row.meta?.askId ? [row.meta.askId] : []));
    for (const askId of askIds) {
      const pending = this.asks.get(askId);
      if (!pending) continue;
      this.asks.delete(askId);
      if (!pending.late) pending.resolve(answer);
    }
  }

  async send(botId: string, text: string): Promise<Message> {
    await this.deps.bots.row(botId);
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        botId,
        role: 'user',
        parts: [{ type: 'text', text }],
        modelMessages: [{ role: 'user', content: text }],
        status: 'done',
      })
      .returning();
    if (!row) throw new Error('Message insert returned no row');
    this.publish(row);
    this.schedule(botId);
    return toMessage(row);
  }

  /** Aborts the bot's current run, if any. */
  stop(botId: string): boolean {
    const controller = this.controllers.get(botId);
    controller?.abort();
    return Boolean(controller);
  }

  /** Starts over: stops the bot, forgets the conversation, tidies its computer up. */
  async clear(botId: string): Promise<void> {
    const bot = await this.deps.bots.row(botId);
    this.stop(botId);
    await this.idle(botId);
    await this.answerAsksOf(bot, `${bot.name} a été réinitialisé et ne répondra pas.`);
    await this.deps.db.delete(messages).where(eq(messages.botId, botId));
    this.deps.events.publish({ type: 'messages.cleared', botId });
    await this.deps.bots.update(botId, { status: 'idle', statusDetail: null });
    if (bot.computerId) {
      clearTimeout(this.tidyTimers.get(botId));
      this.tidyTimers.delete(botId);
      await this.tidy(botId, bot.computerId).catch((error) =>
        this.log.warn({ err: error, botId }, 'Tidy-up failed'),
      );
    }
  }

  /** Resolves when the bot's queue is empty (tests, shutdown). */
  async idle(botId: string): Promise<void> {
    while (this.chains.has(botId)) await this.chains.get(botId);
  }

  /** Resolves when no bot has work queued, including work bots give each other (tests). */
  async settle(): Promise<void> {
    while (this.chains.size > 0) await Promise.allSettled([...this.chains.values()]);
  }

  async close(): Promise<void> {
    for (const timer of this.tidyTimers.values()) clearTimeout(timer);
    this.tidyTimers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.chains.values());
  }

  /** After a hub restart: interrupted runs are marked as such and bots go back to idle. */
  async recover(): Promise<void> {
    await this.deps.db
      .update(messages)
      .set({ status: 'error', errorCode: 'hub_restart', error: null })
      .where(eq(messages.status, 'streaming'));
    await this.deps.db
      .update(bots)
      .set({ status: 'idle', statusDetail: null })
      .where(inArray(bots.status, ['working', 'waiting_bot']));
  }

  private schedule(botId: string): void {
    clearTimeout(this.tidyTimers.get(botId));
    this.tidyTimers.delete(botId);
    const previous = this.chains.get(botId) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(botId))
      .catch((error) => this.log.error({ err: error, botId }, 'Bot run crashed'))
      .finally(() => {
        if (this.chains.get(botId) === next) this.chains.delete(botId);
      });
    this.chains.set(botId, next);
  }

  private publish(row: MessageRow): void {
    this.deps.events.publish({ type: 'message.updated', message: toMessage(row) });
  }

  private async save(id: string, values: Partial<MessageRow>): Promise<MessageRow> {
    const [row] = await this.deps.db
      .update(messages)
      .set(values)
      .where(eq(messages.id, id))
      .returning();
    if (!row) throw new Error('Message vanished');
    this.publish(row);
    return row;
  }

  /**
   * Models to try in order: the main one (or the light one for check-ins), then the
   * fallbacks. Models of deleted providers are left out.
   */
  private async modelChain(bot: BotRow, light: boolean): Promise<LanguageModel[]> {
    if (this.deps.modelFor) {
      const scripted = this.deps.modelFor(bot);
      return scripted ? [scripted].flat() : [];
    }
    const refs: ModelRef[] = [
      ...(light && bot.lightModel ? [bot.lightModel] : []),
      ...(bot.providerId && bot.model ? [{ providerId: bot.providerId, model: bot.model }] : []),
      ...bot.fallbacks,
    ];
    const models: LanguageModel[] = [];
    for (const ref of refs) {
      const provider = await this.deps.providers.row(ref.providerId).catch(() => null);
      if (provider) models.push(this.deps.providers.languageModel(provider, ref.model));
    }
    return models;
  }

  /** Previous turns, oldest first, starting with a user message. */
  private async history(botId: string, before: Date): Promise<ModelMessage[]> {
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.botId, botId), lt(messages.createdAt, before)))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    const transcript = rows
      .reverse()
      .filter((row) => row.status !== 'streaming')
      .flatMap((row) => row.modelMessages);
    const firstUser = transcript.findIndex((m) => m.role === 'user');
    return firstUser < 0 ? [] : transcript.slice(firstUser);
  }

  /** The bot's computer, started on demand. */
  private async computerAgent(computerId: string): Promise<AgentClient> {
    const { computers } = this.deps;
    let pc = await computers.get(computerId);
    if (pc.status !== 'running') {
      await computers.start(computerId);
      await computers.waitForBoot(computerId);
      pc = await computers.get(computerId);
      if (pc.status !== 'running') {
        throw new Error(`Le PC n'a pas pu démarrer : ${pc.statusDetail ?? pc.status}`);
      }
    }
    void computers.touch(computerId);
    return computers.agentFor(computerId);
  }

  private planTidy(botId: string, computerId: string): void {
    clearTimeout(this.tidyTimers.get(botId));
    const timer = setTimeout(() => {
      this.tidyTimers.delete(botId);
      this.tidy(botId, computerId).catch((error) =>
        this.log.warn({ err: error, botId }, 'Tidy-up failed'),
      );
    }, this.deps.tidyAfterMs ?? TIDY_AFTER_MS);
    timer.unref();
    this.tidyTimers.set(botId, timer);
  }

  /** Closes the tabs and apps an idle bot left open; never while the user has the mouse. */
  async tidy(botId: string, computerId: string): Promise<void> {
    if (this.chains.has(botId)) return; // Working: the end of that run plans the next one.
    const pc = await this.deps.computers.get(computerId);
    if (pc.status !== 'running') return; // Asleep: nothing is open.
    const agent = await this.deps.computers.agentFor(computerId);
    if ((await agent.health()).controlLocked) return this.planTidy(botId, computerId);
    await closeOpened(agent, botId, openedBy(await inventory(agent, botId)));
  }

  /** Windows that appeared while the bot worked are its own (to close when tidying up). */
  private async afterRun(
    botId: string,
    computerId: string,
    windowsBefore: Promise<Set<string> | null> | null,
  ): Promise<void> {
    try {
      const before = windowsBefore ? await windowsBefore : null;
      if (before) {
        const agent = await this.deps.computers.agentFor(computerId);
        const opened = (await inventory(agent, botId)).windows.filter((w) => !before.has(w.id));
        await rememberWindows(
          agent,
          botId,
          opened.map((w) => w.id),
        );
      }
    } catch (error) {
      this.log.warn({ err: error, botId }, 'Could not record opened windows');
    }
    this.planTidy(botId, computerId);
  }

  /** The routine runs a run answers: close them, tidy idle check-ins, tell the user if asked. */
  private async settleRoutines(
    runIds: string[],
    bot: BotRow,
    outcome:
      | {
          ok: true;
          answer: string;
          usedTools: boolean;
          messageIds: string[];
          /** Only check-ins came in: an idle answer can be tidied away. */
          tidyable: boolean;
        }
      | { ok: false; stopped: boolean; error: string },
  ): Promise<void> {
    const { routines, notifications } = this.deps;
    for (const runId of runIds) {
      const [run] = await this.deps.db.select().from(routineRuns).where(eq(routineRuns.id, runId));
      const routine = run ? await routines.row(run.routineId).catch(() => null) : null;
      if (!run || !routine) continue;
      if (!outcome.ok) {
        const settled = await routines.finishRun(runId, outcome.stopped ? 'skipped' : 'error', {
          detail: outcome.stopped ? 'Interrompu' : outcome.error,
        });
        if (settled?.disabled) {
          await notifications.create({
            botId: bot.id,
            priority: 'normal',
            title: `Routine « ${routine.name} » désactivée`,
            body: `${bot.name} a échoué ${MAX_FAILURES} fois de suite : ${outcome.error}`,
          });
        }
        continue;
      }
      const idle = !outcome.usedTools && IDLE_ANSWER.test(outcome.answer);
      if (idle && outcome.tidyable) {
        // Nothing to do: the check-in leaves no trace in the conversation.
        for (const id of outcome.messageIds) {
          await this.deps.db.delete(messages).where(eq(messages.id, id));
          this.deps.events.publish({ type: 'message.deleted', botId: bot.id, messageId: id });
        }
        await routines.finishRun(runId, 'idle', { messageId: null });
        continue;
      }
      await routines.finishRun(runId, 'done', { messageId: outcome.messageIds.at(-1) ?? null });
      if (!routine.silent && outcome.answer) {
        await notifications.create({
          botId: bot.id,
          priority: 'normal',
          title: routine.name,
          body: outcome.answer.slice(0, 500),
        });
      }
    }
  }

  private async run(botId: string): Promise<void> {
    const { db, events } = this.deps;
    const bot = await this.deps.bots.row(botId);
    const recent = await db
      .select()
      .from(messages)
      .where(eq(messages.botId, botId))
      .orderBy(desc(messages.createdAt))
      .limit(HISTORY_MESSAGES);
    // Already answered (messages sent in a burst are handled by a single run).
    if (recent[0]?.role !== 'user') return;
    // What arrived since the bot last spoke: the user resets the bot-to-bot hop count.
    const answered = recent.findIndex((m) => m.role !== 'user');
    const incoming = answered < 0 ? recent : recent.slice(0, answered);
    const autonomous = !incoming.some(fromOwner);
    const depth = autonomous ? Math.max(0, ...incoming.map((m) => m.meta?.depth ?? 0)) : 0;
    const askIds = incoming.flatMap((m) =>
      m.kind === 'ask' && m.meta?.askId ? [m.meta.askId] : [],
    );
    const routineRunIds = incoming.flatMap((m) => (m.meta?.runId ? [m.meta.runId] : []));
    // A run made only of check-ins can use the bot's cheaper model.
    const checkInOnly =
      routineRunIds.length === incoming.length &&
      (
        await Promise.all(
          incoming.map((m) =>
            m.meta?.routineId
              ? this.deps.routines.row(m.meta.routineId).then(
                  (r) => r.kind !== 'custom',
                  () => false,
                )
              : false,
          ),
        )
      ).every(Boolean);

    const [created] = await db
      .insert(messages)
      .values({
        botId,
        role: 'assistant',
        parts: [],
        modelMessages: [],
        status: 'streaming',
        ...(autonomous ? { meta: { autonomous: true } } : {}),
      })
      .returning();
    if (!created) throw new Error('Message insert returned no row');
    this.publish(created);

    const models = await this.modelChain(bot, checkInOnly);
    if (models.length === 0) {
      await this.save(created.id, { status: 'error', errorCode: 'no_model', error: null });
      await this.settleAsks(askIds, bot, `${bot.name} n'a pas de modèle configuré.`);
      await this.settleRoutines(routineRunIds, bot, {
        ok: false,
        stopped: false,
        error: 'Aucun modèle configuré',
      });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(botId, controller);
    await this.deps.bots.update(botId, { status: 'working', statusDetail: null });
    const parts: MessagePart[] = [];
    const computerId = bot.computerId;
    // Windows open before the bot first touched its computer during this run.
    const watch: { windowsBefore: Promise<Set<string> | null> | null } = { windowsBefore: null };

    try {
      const [account] = await db
        .select({ name: owner.displayName, locale: owner.locale })
        .from(owner)
        .limit(1);
      const allTeams = await this.deps.org.listTeams();
      const allBots = await db.select().from(bots).orderBy(bots.createdAt);
      const pendingImages: string[] = [];
      const tools = {
        ...buildTools({
          botId,
          botName: bot.name,
          workspaceId: bot.workspaceId,
          files: this.deps.files,
          events,
          shared: computerId
            ? {
                computerId,
                screen: this.screen,
                locks: this.locks,
                neighbours: async () =>
                  (await db.select().from(bots).where(eq(bots.computerId, computerId))).filter(
                    (b) => b.id !== botId,
                  ),
              }
            : null,
          computer: computerId
            ? async () => {
                const agent = await this.computerAgent(computerId);
                watch.windowsBefore ??= inventory(agent, botId).then(
                  (inv) => new Set(inv.windows.map((w) => w.id)),
                  () => null,
                );
                await watch.windowsBefore;
                return agent;
              }
            : null,
          pendingImages,
        }),
        ...(await buildOrgTools({
          self: bot,
          depth: depth + 1,
          runtime: this,
          org: this.deps.org,
          tasks: this.tasks,
          bots: this.deps.bots,
          db,
        })),
        ...buildProactiveTools({
          self: bot,
          routines: this.deps.routines,
          notifications: this.deps.notifications,
          bots: this.deps.bots,
          db,
        }),
        ...buildCanvasTools({ self: bot, canvases: this.deps.canvases }),
      };
      const system = systemPrompt({
        bot,
        ownerName: account?.name ?? "l'utilisateur",
        locale: account?.locale ?? 'fr',
        teams: allTeams,
        bots: allBots,
        hasComputer: Boolean(computerId),
        sharesComputer: allBots.some((b) => b.id !== botId && b.computerId === computerId),
        timeZone: this.deps.routines.timeZone,
        now: new Date(),
      });
      const history = await this.history(botId, created.createdAt);

      const appendText = (kind: 'text' | 'reasoning', text: string) => {
        const tail = parts.at(-1);
        if (tail && tail.type === kind) tail.text += text;
        else parts.push({ type: kind, text });
        events.publish({
          type: 'message.delta',
          botId,
          messageId: created.id,
          partIndex: parts.length - 1,
          kind,
          text,
        });
      };
      const toolPart = (toolCallId: string) =>
        parts.find(
          (p): p is Extract<MessagePart, { type: 'tool' }> =>
            p.type === 'tool' && p.toolCallId === toolCallId,
        );
      const checkpoint = () => this.save(created.id, { parts: structuredClone(parts) });

      const streamWith = async (model: LanguageModel) => {
        const result = streamText({
          model,
          system,
          messages: history,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // Screenshots taken during a step are shown once, at the next step, as images.
          prepareStep: ({ messages: stepMessages }) => {
            if (pendingImages.length === 0) return undefined;
            const images = pendingImages.splice(0);
            return {
              messages: [
                ...stepMessages,
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: "Capture de l'écran de ton PC (1280×800) :" },
                    ...images.map((image) => ({
                      type: 'file' as const,
                      data: image,
                      mediaType: 'image/png',
                    })),
                  ],
                },
              ],
            };
          },
          abortSignal: controller.signal,
          maxRetries: 2,
        });

        for await (const chunk of result.fullStream) {
          switch (chunk.type) {
            case 'text-delta':
              appendText('text', chunk.text);
              break;
            case 'reasoning-delta':
              appendText('reasoning', chunk.text);
              break;
            case 'tool-call':
              parts.push({
                type: 'tool',
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
                state: 'running',
              });
              await checkpoint();
              break;
            case 'tool-result': {
              const part = toolPart(chunk.toolCallId);
              if (part) {
                part.state = 'done';
                Object.assign(
                  part,
                  summarize(chunk.toolName, chunk.input, chunk.output, bot.workspaceId),
                );
              }
              await checkpoint();
              break;
            }
            case 'tool-error': {
              const part = toolPart(chunk.toolCallId);
              if (part) {
                part.state = 'error';
                part.output = errorMessage(chunk.error);
              }
              await checkpoint();
              break;
            }
            case 'error':
              throw chunk.error;
          }
        }
        return {
          transcript: await result.responseMessages,
          usage: await result.totalUsage,
        };
      };

      // The main model, then the fallbacks, as long as nothing was produced yet.
      let outcome: Awaited<ReturnType<typeof streamWith>> | null = null;
      for (const [index, model] of models.entries()) {
        try {
          outcome = await streamWith(model);
          break;
        } catch (error) {
          const last = index === models.length - 1;
          if (last || controller.signal.aborted || parts.length > 0) throw error;
          this.log.warn({ err: error, botId }, 'Model failed, trying the next one');
        }
      }
      if (!outcome) throw new Error('No model answered');

      await this.save(created.id, {
        parts,
        modelMessages: stripBinary(outcome.transcript) as ModelMessage[],
        status: 'done',
        usage: {
          inputTokens: outcome.usage.inputTokens ?? 0,
          outputTokens: outcome.usage.outputTokens ?? 0,
        },
      });
      await this.deps.bots.update(botId, { status: 'idle', statusDetail: null });
      const answer = textOf(parts);
      await this.settleAsks(askIds, bot, answer || '(pas de réponse écrite)');
      await this.settleRoutines(routineRunIds, bot, {
        ok: true,
        answer,
        usedTools: parts.some((p) => p.type === 'tool'),
        messageIds: [...incoming.map((m) => m.id), created.id],
        tidyable: checkInOnly,
      });
    } catch (error) {
      const stopped = controller.signal.aborted;
      const text = textOf(parts);
      for (const part of parts)
        if (part.type === 'tool' && part.state === 'running') part.state = 'error';
      await this.save(created.id, {
        parts,
        // Keep what was said so the next turn has context.
        modelMessages: text ? [{ role: 'assistant', content: text }] : [],
        status: stopped ? 'stopped' : 'error',
        errorCode: stopped ? null : 'run_failed',
        error: stopped ? null : errorMessage(error),
      });
      await this.deps.bots.update(botId, {
        status: stopped ? 'idle' : 'error',
        statusDetail: stopped ? null : errorMessage(error),
      });
      if (!stopped) this.log.warn({ err: error, botId }, 'Bot run failed');
      await this.settleAsks(
        askIds,
        bot,
        stopped
          ? `${bot.name} a été interrompu avant de répondre.`
          : `${bot.name} n'a pas pu répondre : ${errorMessage(error)}`,
      );
      await this.settleRoutines(routineRunIds, bot, {
        ok: false,
        stopped,
        error: errorMessage(error),
      });
    } finally {
      this.controllers.delete(botId);
      this.screen.releaseAll(botId);
      this.locks.releaseAll(botId);
    }
    if (computerId) await this.afterRun(botId, computerId, watch.windowsBefore);
  }
}
