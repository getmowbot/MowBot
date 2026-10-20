import type { Message, MessagePart } from '@mowbot/contract';
import { type LanguageModel, type ModelMessage, stepCountIs, streamText } from 'ai';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { type BotRow, type BotService, toMessage } from '../bots/service';
import type { AgentClient, ExecResult } from '../computers/agent-client';
import type { ComputerService, Logger } from '../computers/service';
import type { Db } from '../db/client';
import { bots, messages, owner, teams } from '../db/schema';
import type { EventBus } from '../events';
import type { ProviderService } from '../providers/service';
import type { WorkspaceFiles } from '../workspaces/files';
import { closeOpened, inventory, openedBy, rememberWindows } from './desktop';
import { systemPrompt } from './prompt';
import { buildTools, clip } from './tools';

const HISTORY_MESSAGES = 40;
const MAX_STEPS = 30;
const UI_OUTPUT_CHARS = 4_000;
/** After this long without work, what a bot left open on its computer gets closed. */
const TIDY_AFTER_MS = 10 * 60_000;

type MessageRow = typeof messages.$inferSelect;

export interface RuntimeDeps {
  db: Db;
  events: EventBus;
  bots: BotService;
  providers: ProviderService;
  computers: ComputerService;
  files: WorkspaceFiles;
  /** Tests inject a scripted model. */
  modelFor?: (bot: BotRow) => LanguageModel | null;
  tidyAfterMs?: number;
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

  constructor(private readonly deps: RuntimeDeps) {}

  setLogger(log: Logger): void {
    this.log = log;
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
      .set({ status: 'error', error: 'Interrompu par un redémarrage du hub' })
      .where(eq(messages.status, 'streaming'));
    await this.deps.db
      .update(bots)
      .set({ status: 'idle', statusDetail: null })
      .where(inArray(bots.status, ['working']));
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

  private resolveModel(bot: BotRow): LanguageModel | Promise<LanguageModel | null> | null {
    if (this.deps.modelFor) return this.deps.modelFor(bot);
    if (!bot.providerId || !bot.model) return null;
    return this.deps.providers
      .row(bot.providerId)
      .then((provider) => this.deps.providers.languageModel(provider, bot.model as string))
      .catch(() => null);
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

  private async run(botId: string): Promise<void> {
    const { db, events } = this.deps;
    const bot = await this.deps.bots.row(botId);
    const [last] = await db
      .select()
      .from(messages)
      .where(eq(messages.botId, botId))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    // Already answered (messages sent in a burst are handled by a single run).
    if (last?.role !== 'user') return;

    const [created] = await db
      .insert(messages)
      .values({ botId, role: 'assistant', parts: [], modelMessages: [], status: 'streaming' })
      .returning();
    if (!created) throw new Error('Message insert returned no row');
    this.publish(created);

    const model = await this.resolveModel(bot);
    if (!model) {
      await this.save(created.id, {
        status: 'error',
        error: 'Aucun modèle configuré : ajoute un fournisseur dans Réglages → Modèles.',
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
      const [account] = await db.select({ name: owner.displayName }).from(owner).limit(1);
      const [team] = bot.teamId
        ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, bot.teamId))
        : [];
      const pendingImages: string[] = [];
      const tools = buildTools({
        botId,
        botName: bot.name,
        workspaceId: bot.workspaceId,
        files: this.deps.files,
        events,
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
      });

      const result = streamText({
        model,
        system: systemPrompt({
          bot,
          ownerName: account?.name ?? "l'utilisateur",
          teamName: team?.name ?? null,
          hasComputer: Boolean(computerId),
          now: new Date(),
        }),
        messages: await this.history(botId, created.createdAt),
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

      const transcript = await result.responseMessages;
      const usage = await result.totalUsage;
      await this.save(created.id, {
        parts,
        modelMessages: stripBinary(transcript) as ModelMessage[],
        status: 'done',
        usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
      });
      await this.deps.bots.update(botId, { status: 'idle', statusDetail: null });
    } catch (error) {
      const stopped = controller.signal.aborted;
      const text = parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('');
      for (const part of parts)
        if (part.type === 'tool' && part.state === 'running') part.state = 'error';
      await this.save(created.id, {
        parts,
        // Keep what was said so the next turn has context.
        modelMessages: text ? [{ role: 'assistant', content: text }] : [],
        status: stopped ? 'stopped' : 'error',
        error: stopped ? null : errorMessage(error),
      });
      await this.deps.bots.update(botId, {
        status: stopped ? 'idle' : 'error',
        statusDetail: stopped ? null : errorMessage(error),
      });
      if (!stopped) this.log.warn({ err: error, botId }, 'Bot run failed');
    } finally {
      this.controllers.delete(botId);
    }
    if (computerId) await this.afterRun(botId, computerId, watch.windowsBefore);
  }
}
