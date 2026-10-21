import { randomUUID } from 'node:crypto';
import type {
  Bot,
  BotMove,
  Canvas,
  CanvasContent,
  Mention,
  Message,
  MessageKind,
  MessagePart,
  ModelRef,
  Question,
  VaultField,
  VaultRequestAnswer,
} from '@mowbot/contract';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';
import { and, asc, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { type BotRow, type BotService, toMessage } from '../bots/service';
import type { AgentClient, ExecResult } from '../computers/agent-client';
import type { ComputerService, Logger } from '../computers/service';
import type { ConnectorService, ProjectRow } from '../connectors/service';
import type { Db } from '../db/client';
import { bots, type MessageMeta, messages, owner, routineRuns, teams } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem } from '../http/problems';
import { hubTexts } from '../i18n';
import type { McpService } from '../mcp/service';
import type { OrgService } from '../org/service';
import { TaskService } from '../org/tasks';
import type { AutomationService } from '../proactivity/automations';
import type { CanvasService } from '../proactivity/canvases';
import type { NotificationService, SystemService } from '../proactivity/notifications';
import type { QuestionService } from '../proactivity/questions';
import { IDLE_ANSWER, MAX_FAILURES, type RoutineService } from '../proactivity/routines';
import type { ProviderService } from '../providers/service';
import type { PushService } from '../push/service';
import type { SecretScope } from '../vault/secrets';
import type { VaultService } from '../vault/service';
import type { WorkspaceFiles } from '../workspaces/files';
import { buildAutomationTools } from './automation-tools';
import { BrowserHub } from './browser';
import { buildBrowserTools } from './browser-tools';
import { buildCanvasTools, SHOW_IN_CHAT } from './canvas-tools';
import { closeOpened, inventory, openedBy, rememberWindows } from './desktop';
import { buildLocalTools } from './local-tools';
import { buildMcpTools } from './mcp-tools';
import { resolveMentions } from './mentions';
import { buildOrgTools } from './org-tools';
import { buildProactiveTools } from './proactive-tools';
import { systemPrompt } from './prompt';
import { FileLocks, ScreenLeases } from './shared-pc';
import { buildTools, clip } from './tools';
import { buildVaultTools, VAULT_REQUEST } from './vault-tools';

const HISTORY_MESSAGES = 40;
const MAX_STEPS = 30;
/** An answer that took this long reaches the phone: the user has probably moved on. */
const FINISHED_PUSH_AFTER_MS = 15_000;
const UI_OUTPUT_CHARS = 4_000;
/** After this long without work, what a bot left open on its computer gets closed. */
const TIDY_AFTER_MS = 10 * 60_000;
/** Bot-to-bot hops without the user before bots must stop writing to each other. */
export const MAX_DEPTH = 10;
/** Messages, questions and tasks a bot may send other bots per hour. */
const MAX_SENDS_PER_HOUR = 60;
const ASK_TIMEOUT_MS = 15 * 60_000;

type MessageRow = typeof messages.$inferSelect;

/** Tools whose result is drawn in the answer itself, not shown as a tool call. */
const SHOWN_TOOLS = new Set([SHOW_IN_CHAT, VAULT_REQUEST]);

/** A message that came in mid-answer, as the model sees it. */
function steeredMessages(row: MessageRow): ModelMessage[] {
  return row.modelMessages.map((message) =>
    message.role === 'user' && typeof message.content === 'string'
      ? { ...message, content: `[Arrivé pendant que tu travaillais]\n${message.content}` }
      : message,
  );
}

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
  questions: QuestionService;
  vault: VaultService;
  /** Tells the user's phones when a bot finished what they asked. */
  push?: PushService;
  automations?: AutomationService;
  mcp?: McpService;
  connectors?: ConnectorService;
  finishedPushAfterMs?: number;
  /** Shared with the vault, which reads and writes the computers' Chrome. */
  browser?: BrowserHub;
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
  if (toolName === 'screenshot' || toolName === 'browser_screenshot') {
    const saved = (output as { saved?: string | null }).saved;
    return {
      output: toolName === 'screenshot' ? "Capture de l'écran" : 'Capture de la page',
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

/** The vault's secrets never come back to the model, nor to the app, in a tool's output. */
function masked(secrets: SecretScope, tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, entry]) => {
      const { execute } = entry;
      if (!execute) return [name, entry];
      return [
        name,
        {
          ...entry,
          execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
            try {
              return secrets.mask(await execute(input, options));
            } catch (error) {
              throw secrets.maskError(error);
            }
          },
        },
      ];
    }),
  );
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
  /** Each bot's own Chrome window, driven over DevTools. */
  readonly browser: BrowserHub;
  readonly tasks: TaskService;

  constructor(private readonly deps: RuntimeDeps) {
    this.browser = deps.browser ?? new BrowserHub();
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
  async checkReach(
    from: BotRow,
    to: BotRow,
    depth: number,
    options: { allowSelf?: boolean } = {},
  ): Promise<void> {
    if (from.id === to.id && !options.allowSelf) throw new Error("C'est toi.");
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

  async send(botId: string, text: string, mentions: Mention[] = []): Promise<Message> {
    const bot = await this.deps.bots.row(botId);
    // Writing to the bot moves on from the questions it asked.
    await this.deps.questions.closeOpen(botId);
    const { context, kept } = await resolveMentions(this.deps, bot, mentions);
    return this.post(
      botId,
      context
        ? `${text}

${context}`
        : text,
      text,
      kept.length > 0 ? { mentions: kept } : undefined,
    );
  }

  /** The user answered a bot's question: the answer reaches the bot as their message. */
  async answerQuestion(id: string, answer: string): Promise<Question> {
    const { vaultItemId, projectCommand } = await this.deps.questions.row(id);
    const question = await this.deps.questions.answer(id, answer);
    // An access request: the decision is recorded before the bot hears it.
    if (vaultItemId) await this.deps.vault.answered(vaultItemId, question.botId, answer);
    if (projectCommand) {
      await this.deps.connectors?.commandAnswered(projectCommand, question.botId, answer);
    }
    await this.post(
      question.botId,
      `[Réponse à ta question « ${question.question} »]\n${answer}`,
      answer,
    );
    return question;
  }

  /** A message from the user: `text` for the bot, `display` for the app. */
  private async post(
    botId: string,
    text: string,
    display: string,
    meta?: MessageMeta,
  ): Promise<Message> {
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        botId,
        role: 'user',
        parts: [{ type: 'text', text: display }],
        modelMessages: [{ role: 'user', content: text }],
        status: 'done',
        ...(meta ? { meta } : {}),
      })
      .returning();
    if (!row) throw new Error('Message insert returned no row');
    this.publish(row);
    this.schedule(botId);
    return toMessage(row);
  }

  /**
   * A long answer to the user reaches their phone, unless the bot ended by asking them
   * something (that question makes its own notification).
   */
  private pushFinished(
    bot: BotRow,
    answer: MessageRow,
    parts: MessagePart[],
    autonomous: boolean,
    text: string,
    error: string | null,
  ): void {
    const after = this.deps.finishedPushAfterMs ?? FINISHED_PUSH_AFTER_MS;
    if (autonomous || Date.now() - answer.createdAt.getTime() < after) return;
    const asked = parts.some(
      (p) => (p.type === 'tool' && p.toolName === 'ask_user') || p.type === 'vault_request',
    );
    if (asked) return;
    void hubTexts(this.deps.db).then((texts) =>
      this.deps.push?.notify({
        kind: 'finished',
        botId: bot.id,
        botName: bot.name,
        title: error ? texts.failed(bot.name) : texts.finished(bot.name),
        body: error ?? text,
      }),
    );
  }

  /** Messages that came in since the answer started and can join it; marks them as taken. */
  private async steerInto(botId: string, answer: MessageRow): Promise<MessageRow[]> {
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.botId, botId),
          eq(messages.role, 'user'),
          eq(messages.kind, 'chat'),
          gt(messages.createdAt, answer.createdAt),
        ),
      )
      .orderBy(asc(messages.createdAt));
    const taken: MessageRow[] = [];
    for (const row of rows) {
      if (row.meta?.steeredInto) continue;
      taken.push(await this.save(row.id, { meta: { ...row.meta, steeredInto: answer.id } }));
    }
    return taken;
  }

  private async unsteer(answerId: string): Promise<void> {
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(sql`${messages.meta}->>'steeredInto' = ${answerId}`);
    for (const row of rows) {
      const { steeredInto: _, ...meta } = row.meta ?? {};
      await this.save(row.id, { meta });
    }
  }

  /** Context for the bot's next turn that calls for no answer now (it is not woken up). */
  async note(botId: string, text: string, display: string): Promise<void> {
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        botId,
        role: 'user',
        kind: 'routine',
        meta: { silent: true },
        parts: [{ type: 'text', text: display }],
        modelMessages: [{ role: 'user', content: text }],
        status: 'done',
      })
      .returning();
    if (row) this.publish(row);
  }

  /**
   * A bot stops another one's run. The stopped bot keeps a note of who and why, and goes on
   * only when someone writes to it.
   */
  async stopBy(stopper: BotRow, target: BotRow, reason: string): Promise<boolean> {
    if (!this.stop(target.id)) return false;
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        botId: target.id,
        role: 'user',
        fromBotId: stopper.id,
        kind: 'chat',
        meta: { fromName: stopper.name, silent: true },
        parts: [
          { type: 'text', text: (await hubTexts(this.deps.db)).stoppedBy(stopper.name, reason) },
        ],
        modelMessages: [{ role: 'user', content: `[${stopper.name} t'a arrêté : ${reason}]` }],
        status: 'done',
      })
      .returning();
    if (row) this.publish(row);
    return true;
  }

  /** The user pressed a button of a card the bot showed: its reply reaches the bot. */
  async pressCard(
    botId: string,
    messageId: string,
    part: number,
    button: number,
  ): Promise<Message> {
    const [row] = await this.deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.botId, botId)));
    const card = row?.parts[part];
    if (!row || card?.type !== 'canvas' || card.content.kind !== 'card') {
      throw new HttpProblem(404, 'card_not_found', 'No such card in this message');
    }
    const pressed = card.content.buttons[button];
    if (!pressed) throw new HttpProblem(404, 'button_not_found', 'No such button on this card');
    if (card.pressed) throw new HttpProblem(409, 'card_answered', 'This card was already answered');
    const updated = await this.save(row.id, {
      parts: row.parts.map((p, i) => (i === part ? { ...card, pressed: pressed.label } : p)),
    });
    await this.post(
      botId,
      `[Bouton « ${pressed.label} » de ta carte « ${card.content.title} »]\n${pressed.reply ?? pressed.label}`,
      pressed.label,
    );
    return toMessage(updated);
  }

  /**
   * The user answers a vault request: the values go straight into the vault, and the bot only
   * hears which entry it can now use (or that the user declined).
   */
  async answerVaultRequest(
    botId: string,
    messageId: string,
    answer: VaultRequestAnswer,
  ): Promise<Message> {
    const [row] = await this.deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.botId, botId)));
    const request = row?.parts[answer.part];
    if (!row || request?.type !== 'vault_request') {
      throw new HttpProblem(404, 'request_not_found', 'No such vault request in this message');
    }
    if (request.status !== 'pending') {
      throw new HttpProblem(409, 'request_answered', 'This request was already answered');
    }
    const label = `${request.service}${request.account ? ` (${request.account})` : ''}`;
    if (answer.declined) {
      const updated = await this.save(row.id, {
        parts: row.parts.map((p, i) =>
          i === answer.part ? { ...request, status: 'declined' } : p,
        ),
      });
      await this.post(
        botId,
        `[Coffre] L'utilisateur n'a pas voulu ranger ${label} : fais sans, ou demande-lui autrement.`,
        (await hubTexts(this.deps.db)).vaultDeclined(label),
      );
      return toMessage(updated);
    }
    // Only the fields the bot asked for, and only those filled in.
    const values = Object.fromEntries(
      request.fields.flatMap((field) => {
        const value = answer.values?.[field];
        return value ? [[field, value]] : [];
      }),
    ) as Partial<Record<VaultField, string>>;
    if (Object.keys(values).length === 0) {
      throw new HttpProblem(400, 'empty_answer', 'Fill in at least one field');
    }
    const existing = request.itemId
      ? await this.deps.vault.row(request.itemId).catch(() => null)
      : null;
    const item = existing
      ? await this.deps.vault.update(existing.id, values)
      : request.kind === 'secret'
        ? await this.deps.vault.create(
            {
              kind: 'secret',
              service: request.service,
              account: request.account,
              sites: request.sites,
              value: values.value ?? '',
            },
            { botId },
          )
        : await this.deps.vault.create(
            {
              kind: 'login',
              service: request.service,
              account: request.account,
              sites: request.sites,
              username: values.username,
              password: values.password,
              totp: values.totp,
            },
            { botId },
          );
    const updated = await this.save(row.id, {
      parts: row.parts.map((p, i) =>
        i === answer.part ? { ...request, status: 'saved', itemId: item.id } : p,
      ),
    });
    const placeholders = item.fields.map((f) => `{{vault:${item.ref}.${f}}}`).join(', ');
    await this.post(
      botId,
      `[Coffre] L'utilisateur a rangé ${label} dans le coffre (référence ${item.ref}) : utilise ${placeholders}. Tu n'en verras jamais les valeurs.`,
      (await hubTexts(this.deps.db)).vaultSaved(label),
    );
    return toMessage(updated);
  }

  /** A card on the home page: its button answers the bot that pinned it. */
  async pressCanvas(canvas: Canvas, button: number): Promise<void> {
    if (canvas.content.kind !== 'card') {
      throw new HttpProblem(404, 'card_not_found', 'This canvas is not a card');
    }
    const pressed = canvas.content.buttons[button];
    if (!pressed) throw new HttpProblem(404, 'button_not_found', 'No such button on this card');
    await this.post(
      canvas.botId,
      `[Bouton « ${pressed.label} » de ton canvas « ${canvas.title} »]\n${pressed.reply ?? pressed.label}`,
      pressed.label,
    );
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
    await this.deps.questions.closeOpen(botId);
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

  /** Moves a bot to another team or computer: it stops and tidies its old computer up first. */
  async moveBot(botId: string, input: BotMove): Promise<Bot> {
    const bot = await this.deps.bots.row(botId);
    if (bot.isChef) return this.deps.org.moveBot(botId, input); // Refused there.
    this.stop(botId);
    await this.idle(botId);
    if (bot.computerId) {
      clearTimeout(this.tidyTimers.get(botId));
      this.tidyTimers.delete(botId);
      await this.tidy(botId, bot.computerId).catch((error) =>
        this.log.warn({ err: error, botId }, 'Tidy-up failed'),
      );
    }
    return this.deps.org.moveBot(botId, input);
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
    await this.browser.close();
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
      .filter((row) => row.status !== 'streaming' && !row.meta?.steeredInto)
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
        const settled = await routines.finishRun(
          runId,
          outcome.stopped ? 'skipped' : 'error',
          outcome.stopped ? { reason: 'interrupted' } : { detail: outcome.error },
        );
        if (settled?.disabled) {
          const texts = await hubTexts(this.deps.db);
          await notifications.create({
            botId: bot.id,
            priority: 'normal',
            title: texts.routineOff(routine.name),
            body: texts.routineOffBody(bot.name, MAX_FAILURES, outcome.error),
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
    // Messages that joined an answer while the bot worked are already handled.
    const recent = (
      await db
        .select()
        .from(messages)
        .where(eq(messages.botId, botId))
        .orderBy(desc(messages.createdAt))
        .limit(HISTORY_MESSAGES)
    ).filter((m) => !m.meta?.steeredInto);
    // Already answered (messages sent in a burst are handled by a single run).
    if (recent[0]?.role !== 'user') return;
    // What arrived since the bot last spoke: the user resets the bot-to-bot hop count.
    const answered = recent.findIndex((m) => m.role !== 'user');
    const incoming = answered < 0 ? recent : recent.slice(0, answered);
    // Notes ("stopped by …") are context for later, not something to answer.
    if (incoming.every((m) => m.meta?.silent)) return;
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
      const secrets = await this.deps.vault.scope(bot);
      const expand = (text: string) => secrets.expand(text);
      const computer = computerId
        ? async () => {
            const agent = await this.computerAgent(computerId);
            watch.windowsBefore ??= inventory(agent, botId).then(
              (inv) => new Set(inv.windows.map((w) => w.id)),
              () => null,
            );
            await watch.windowsBefore;
            return agent;
          }
        : null;
      // Read by the tools when they run: a message steered in can raise the hop count.
      const orgContext = {
        self: bot,
        depth: depth + 1,
        runtime: this,
        org: this.deps.org,
        tasks: this.tasks,
        bots: this.deps.bots,
        files: this.deps.files,
        events,
        db,
      };
      // Cards, pictures, vault forms… shown in the answer, where the bot is in its reply.
      const showPart = async (part: MessagePart) => {
        parts.push(part);
        await this.save(created.id, { parts: structuredClone(parts) });
      };
      const showInChat = (content: CanvasContent) =>
        showPart({ type: 'canvas', content, pressed: null });
      // Folders shared from the user's own computer (desktop app).
      const { connectors } = this.deps;
      const projects: ProjectRow[] = connectors ? await connectors.accessibleTo(bot) : [];
      const machines = connectors ? await connectors.connectorsOf(projects) : new Map();
      const tools = masked(secrets, {
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
          computer,
          pendingImages,
          expand,
        }),
        ...(computerId && computer
          ? buildBrowserTools({
              botId,
              botName: bot.name,
              computerId,
              workspaceId: bot.workspaceId,
              files: this.deps.files,
              browser: this.browser,
              computer,
              pendingImages,
              expand,
            })
          : {}),
        ...(await buildOrgTools(orgContext)),
        ...buildProactiveTools({
          self: bot,
          routines: this.deps.routines,
          notifications: this.deps.notifications,
          questions: this.deps.questions,
          ownerName: account?.name ?? "l'utilisateur",
          bots: this.deps.bots,
          db,
        }),
        ...buildCanvasTools({
          self: bot,
          canvases: this.deps.canvases,
          showInChat,
          files: this.deps.files,
        }),
        ...(this.deps.mcp
          ? await buildMcpTools({ self: bot, mcp: this.deps.mcp, pendingImages })
          : {}),
        ...(this.deps.automations
          ? buildAutomationTools({ self: bot, automations: this.deps.automations })
          : {}),
        ...(connectors
          ? buildLocalTools({
              bot,
              db,
              connectors,
              questions: this.deps.questions,
              projects,
              machines,
            })
          : {}),
        ...buildVaultTools({
          self: bot,
          vault: this.deps.vault,
          db,
          computer,
          showPart,
          notifications: this.deps.notifications,
        }),
      });
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
        vault: await this.deps.vault.promptLines(bot),
        projects: projects.map((p) => {
          const machine = machines.get(p.connectorId);
          const online = connectors?.isOnline(p.connectorId) ? 'en ligne' : 'hors ligne';
          const mode = p.mode === 'auto' ? 'commandes libres' : 'commandes avec accord';
          return `- ${p.name} : ${p.path} (${machine?.hostname ?? machine?.name ?? '?'}${machine?.os ? `, ${machine.os}` : ''}) · ${online} · ${mode}`;
        }),
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

      // Messages that arrive while the bot works join its answer at its next step, where they
      // came in (a step's messages are rebuilt each time, so they are put back every step).
      const steers: { at: number; messages: ModelMessage[] }[] = [];
      const withSteers = (responses: ModelMessage[]) => {
        const out: ModelMessage[] = [];
        let from = 0;
        for (const steer of steers) {
          out.push(...responses.slice(from, steer.at), ...steer.messages);
          from = steer.at;
        }
        return [...out, ...responses.slice(from)];
      };
      const takeSteers = async (at: number) => {
        const rows = await this.steerInto(botId, created);
        if (rows.length === 0) return;
        for (const row of rows) {
          if (row.fromBotId) {
            orgContext.depth = Math.max(orgContext.depth, (row.meta?.depth ?? 0) + 1);
          }
        }
        steers.push({ at, messages: rows.flatMap(steeredMessages) });
      };

      const streamWith = async (model: LanguageModel) => {
        const result = streamText({
          model,
          system,
          messages: history,
          tools,
          stopWhen: stepCountIs(MAX_STEPS),
          // Screenshots taken during a step are shown once, at the next step, as images.
          prepareStep: async ({ messages: stepMessages }) => {
            const responses = stepMessages.slice(history.length);
            await takeSteers(responses.length);
            const images = pendingImages.splice(0);
            if (steers.length === 0 && images.length === 0) return undefined;
            const turn = [...history, ...withSteers(responses)];
            if (images.length === 0) return { messages: turn };
            return {
              messages: [
                ...turn,
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: 'Capture demandée (l’écran du PC fait 1280×800) :' },
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
              // What it shows lands in the answer itself (showPart), not as a tool call.
              if (SHOWN_TOOLS.has(chunk.toolName)) break;
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
        modelMessages: stripBinary(withSteers(outcome.transcript)) as ModelMessage[],
        status: 'done',
        usage: {
          inputTokens: outcome.usage.inputTokens ?? 0,
          outputTokens: outcome.usage.outputTokens ?? 0,
        },
      });
      await this.deps.bots.update(botId, { status: 'idle', statusDetail: null });
      const answer = textOf(parts);
      this.pushFinished(bot, created, parts, autonomous, answer, null);
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
      // Messages steered into a failed answer wait for the next one, like any other.
      await this.unsteer(created.id);
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
      if (!stopped) {
        this.log.warn({ err: error, botId }, 'Bot run failed');
        this.pushFinished(bot, created, parts, autonomous, '', errorMessage(error));
      }
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
