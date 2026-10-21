import type { Bot, CanvasKind, Mention, Message, MessagePart, Problem } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Hand, Maximize2, Monitor, PanelRightClose, Power, Sparkles, Undo2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityGroup, type ActivityPart } from '../components/activity';
import { BotAvatar } from '../components/bot-avatar';
import { BotBrowserView, ViewSwitch } from '../components/bot-browser-view';
import { BotChip } from '../components/bot-chip';
import { BotMenu, RenameField } from '../components/bot-menu';
import { CanvasBody } from '../components/canvas-body';
import { ChatComposer } from '../components/chat-composer';
import { StatusBadge } from '../components/computer-status';
import { Markdown } from '../components/markdown';
import { QuestionCard } from '../components/question-card';
import { TakeoverCard } from '../components/takeover-card';
import { Button } from '../components/ui/button';
import { VaultRequestCard } from '../components/vault-request-card';
import { i18n } from '../i18n';
import { api, problemMessage } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { mentionSegments } from '../lib/chat-input';
import {
  chipBots,
  type IncomingPlace,
  incomingPlaces,
  runSummary,
  senderOf,
  withSender,
} from '../lib/incoming';
import { reveal } from '../lib/motion';
import { useQuestions } from '../lib/proactivity';
import {
  useBot,
  useBots,
  useChef,
  useComputer,
  useComputerAction,
  useMe,
  useMessages,
  useProviders,
} from '../lib/queries';
import { cn } from '../lib/utils';

const DesktopView = lazy(() =>
  import('../components/desktop-view').then((m) => ({ default: m.DesktopView })),
);

const SUGGESTIONS = [
  'chat.suggestions.intro',
  'chat.suggestions.team',
  'chat.suggestions.browse',
  'chat.suggestions.note',
] as const;

const BOT_SUGGESTIONS = [
  'chat.botSuggestions.intro',
  'chat.botSuggestions.mission',
  'chat.botSuggestions.team',
] as const;

/** Why an answer failed, worded in the app's language: the hub gives a code and a detail. */
function failure(message: Message): string {
  switch (message.errorCode) {
    case 'no_model':
    case 'hub_restart':
      return i18n.t(`chat.errors.${message.errorCode}`);
    case 'run_failed':
      return message.error
        ? i18n.t('chat.errors.run_failed', { detail: message.error })
        : i18n.t('chat.errors.generic');
    default:
      return message.error ?? i18n.t('chat.errors.generic');
  }
}

/** Sent while the bot was working: it took it into the answer under way. */
function SteeredHint() {
  const { t } = useTranslation();
  return <p className="px-1 text-[11px] text-faint">{t('chat.steered')}</p>;
}

/** Above a run of incoming messages, quietly: who sent them, and what they are. */
function IncomingLine({ run }: { run: Message[] }) {
  const { t } = useTranslation();
  const bots = useBots();
  const { senders, kinds } = runSummary(run);
  const what = kinds.map((kind) => t(`common.kinds.${kind}`)).join(', ');
  if (senders.length === 0) {
    return <p className="text-center text-xs text-faint first-letter:uppercase">{what}</p>;
  }
  return (
    <p className="text-center text-xs leading-5 text-faint">
      {t('chat.incoming', { count: run.length })}{' '}
      {senders.map((sender, i) => {
        const key = sender.kind === 'bot' ? (sender.id ?? sender.name) : sender.kind;
        const bot = sender.kind === 'bot' ? bots.data?.find((b) => b.id === sender.id) : undefined;
        return (
          <Fragment key={key}>
            {i > 0 && (i === senders.length - 1 ? ` ${t('chat.and')} ` : ', ')}
            {sender.kind === 'bot' ? (
              <BotChip
                plain
                bot={
                  bot ?? {
                    id: null,
                    name: sender.name,
                    avatarSeed: sender.name,
                  }
                }
              />
            ) : (
              <span className="font-medium text-muted-foreground">{t('activityPage.you')}</span>
            )}
          </Fragment>
        );
      })}
      {what && ` · ${what}`}
    </p>
  );
}

/**
 * What another bot, the user (a task) or a routine gave this bot: a soft bubble under a quiet
 * line naming its senders, the bots its text names shown as chips.
 */
function IncomingMessage({ message, place }: { message: Message; place: IncomingPlace }) {
  const bots = useBots();
  const chips = useMemo(() => chipBots(bots.data, message), [bots.data, message]);
  const sender = senderOf(message);
  const from = sender.kind === 'bot' ? chips.find((b) => b.id === sender.id) : undefined;
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  // Several senders above: each message opens with its own.
  const name = sender.kind === 'bot' ? (from?.name ?? sender.name) : null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      {place.run && <IncomingLine run={place.run} />}
      <div className="max-w-[92%] rounded-2xl bg-white/[0.055] px-4 py-2.5">
        <Markdown
          text={place.mixed && name ? withSender(name, text) : text}
          bots={chips}
          className="text-[14px] text-foreground/85"
        />
      </div>
      {message.steered && <SteeredHint />}
    </div>
  );
}

function UserMessage({ message }: { message: Message }) {
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground text-[14.5px] leading-relaxed">
        {mentionSegments(text, message.mentions).map((segment, i) =>
          segment.mention ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments of a fixed text
              key={i}
              className="rounded bg-primary-foreground/10 px-0.5 font-semibold"
            >
              {segment.text}
            </span>
          ) : (
            segment.text
          ),
        )}
      </div>
      {message.steered && <SteeredHint />}
    </div>
  );
}

type CanvasPart = Extract<MessagePart, { type: 'canvas' }>;

/** Room each kind takes in the conversation: a card stays card-sized, pictures spread out. */
const CANVAS_FRAME: Record<CanvasKind, string> = {
  note: 'glass max-w-md rounded-2xl p-4',
  score: 'glass max-w-md rounded-2xl p-4',
  stats: 'glass max-w-md rounded-2xl p-4',
  checklist: 'glass max-w-md rounded-2xl p-4',
  html: 'glass rounded-2xl p-4',
  card: 'glass max-w-sm rounded-2xl p-3',
  gallery: '',
  file: 'glass max-w-md rounded-2xl p-3',
};

/** What the bot showed in its answer, drawn as on the home page; a card's buttons answer it once. */
function MessageCanvas({
  message,
  part,
  index,
  workspaceId,
  onAnswer,
}: {
  message: Message;
  part: CanvasPart;
  index: number;
  workspaceId: string | null;
  onAnswer(): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { content } = part;
  const press = useMutation({
    mutationFn: async (button: number) => {
      const { data, error } = await api.POST('/api/v1/bots/{id}/messages/{messageId}/press', {
        params: { path: { id: message.botId, messageId: message.id } },
        body: { part: index, button },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: () => onAnswer(),
    onSuccess: (updated) =>
      queryClient.setQueryData<Message[]>(['messages', updated.botId], (list) =>
        list?.map((m) => (m.id === updated.id ? updated : m)),
      ),
    // Answered meanwhile (another device): the hub has the truth.
    onError: () => queryClient.invalidateQueries({ queryKey: ['messages', message.botId] }),
  });
  const pressing =
    content.kind === 'card' && press.isPending && press.variables !== undefined
      ? content.buttons[press.variables]?.label
      : undefined;
  const answeredElsewhere = (press.error as Partial<Problem> | null)?.status === 409;
  return (
    <div className={CANVAS_FRAME[content.kind]}>
      <CanvasBody
        content={content}
        workspaceId={workspaceId}
        version={message.id}
        press={{
          onPress: (button) => press.mutate(button),
          chosen: part.pressed ?? pressing,
          pending: press.isPending,
        }}
      />
      {press.isError && !answeredElsewhere && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {problemMessage(press.error, t('common.actionFailed'))}
        </p>
      )}
    </div>
  );
}

type Segment =
  | { kind: 'text'; text: string; index: number }
  | { kind: 'canvas'; part: CanvasPart; index: number }
  | { kind: 'vault'; part: Extract<MessagePart, { type: 'vault_request' }>; index: number }
  | { kind: 'takeover'; part: Extract<MessagePart, { type: 'takeover_request' }>; index: number }
  | { kind: 'activity'; parts: ActivityPart[]; index: number };

/**
 * Text, what the bot showed and what it asks for stay as they are; the tool calls and
 * reasoning between them become one activity.
 */
function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim()) out.push({ kind: 'text', text: part.text, index });
      return;
    }
    if (part.type === 'canvas') {
      out.push({ kind: 'canvas', part, index });
      return;
    }
    if (part.type === 'vault_request') {
      out.push({ kind: 'vault', part, index });
      return;
    }
    if (part.type === 'takeover_request') {
      out.push({ kind: 'takeover', part, index });
      return;
    }
    const tail = out.at(-1);
    if (tail?.kind === 'activity') tail.parts.push(part);
    else out.push({ kind: 'activity', parts: [part], index });
  });
  return out;
}

function BotMessage({
  message,
  bot,
  onAnswer,
  onShowPc,
}: {
  message: Message;
  bot: Bot;
  /** The user pressed a card's button or answered a vault request: their answer follows. */
  onAnswer(): void;
  /** Opens the PC panel (to take control from a takeover card). */
  onShowPc(): void;
}) {
  const { t } = useTranslation();
  const streaming = message.status === 'streaming';
  const blocks = segments(message.parts);
  const empty = blocks.length === 0;
  return (
    <div className="flex gap-3">
      <BotAvatar
        seed={bot.avatarSeed}
        size={30}
        mood={streaming ? moodOf(bot, message) : 'idle'}
        className="shrink-0"
      />
      {/* First lines (24px tall) are centred on the 30px avatar. */}
      <div className="min-w-0 flex-1 space-y-2.5 pt-[3px]">
        {empty && streaming && (
          <p className="shimmer-text text-[14.5px] leading-6">
            {t('chat.thinking', { name: bot.name })}
          </p>
        )}
        {blocks.map((block, i) => {
          const last = i === blocks.length - 1;
          if (block.kind === 'canvas') {
            return (
              <MessageCanvas
                key={`canvas-${block.index}`}
                message={message}
                part={block.part}
                index={block.index}
                workspaceId={bot.workspaceId}
                onAnswer={onAnswer}
              />
            );
          }
          if (block.kind === 'vault') {
            return (
              <VaultRequestCard
                key={`vault-${block.index}`}
                message={message}
                part={block.part}
                index={block.index}
                onAnswer={onAnswer}
              />
            );
          }
          if (block.kind === 'takeover') {
            return (
              <TakeoverCard
                key={`takeover-${block.index}`}
                part={block.part}
                botName={bot.name}
                onShowPc={onShowPc}
              />
            );
          }
          return block.kind === 'activity' ? (
            <ActivityGroup
              key={`activity-${block.index}`}
              parts={block.parts}
              live={streaming && last}
            />
          ) : (
            <Markdown
              key={`text-${block.index}`}
              text={block.text}
              className={cn(streaming && last && 'streaming')}
            />
          );
        })}
        {message.status === 'error' && (
          <p className="rounded-xl border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-sm text-destructive">
            {failure(message)}
          </p>
        )}
        {message.status === 'stopped' && <p className="text-xs text-faint">{t('chat.stopped')}</p>}
      </div>
    </div>
  );
}

function EmptyState({ bot, onPick }: { bot: Bot; onPick(text: string): void }) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.06 } } }}
      className="mx-auto flex max-w-xl flex-col items-center gap-5 py-[8vh] text-center"
    >
      <motion.div variants={reveal}>
        <BotAvatar seed={bot.avatarSeed} size={132} followPointer />
      </motion.div>
      <motion.div variants={reveal} className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          {bot.isChef ? t('chat.greetingChef') : t('chat.greeting', { name: bot.name })}
        </h1>
        <p className="text-muted-foreground">{bot.isChef ? t('chat.chefIntro') : bot.role}</p>
        {!bot.isChef && bot.mission && <p className="text-sm text-faint">{bot.mission}</p>}
      </motion.div>
      <motion.div variants={reveal} className="flex flex-wrap justify-center gap-2">
        {(bot.isChef ? SUGGESTIONS : BOT_SUGGESTIONS).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onPick(t(key))}
            className="rounded-full border border-border-strong bg-white/[0.02] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
          >
            {t(key)}
          </button>
        ))}
      </motion.div>
    </motion.div>
  );
}

function ComputerPanel({
  computerId,
  bot,
  onClose,
}: {
  computerId: string;
  bot: { id: string; name: string };
  onClose(): void;
}) {
  const { t } = useTranslation();
  const computer = useComputer(computerId);
  const action = useComputerAction(computerId);
  const pc = computer.data;
  const me = useMe();
  const control = pc?.control;
  const inControl = Boolean(control && control.deviceId === me.data?.device.id);
  // The bot browses in its own window, which the screen doesn't show.
  const [shown, setShown] = useState<'bot' | 'screen'>('bot');
  const takeOver = () => {
    action.mutate('takeover');
    setShown('screen');
  };
  // Control taken from elsewhere (a bot's takeover card): the screen is what the user drives.
  useEffect(() => {
    if (inControl) setShown('screen');
  }, [inControl]);
  return (
    <motion.aside
      initial={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: 24, filter: 'blur(8px)' }}
      transition={springs.soft}
      className="glass fixed inset-x-3 bottom-3 top-16 z-40 flex flex-col gap-3 rounded-2xl p-3 lg:static lg:inset-auto lg:z-auto lg:w-[46%] lg:max-w-3xl lg:rounded-none lg:border-y-0 lg:border-r-0 lg:p-4"
    >
      <div className="flex items-center gap-2">
        <Monitor className="size-4 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{pc?.name ?? 'PC'}</span>
        {pc && <StatusBadge status={pc.status} />}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('chat.closePc')}>
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      {pc?.status === 'running' && (
        <ViewSwitch
          value={shown}
          options={[
            { value: 'bot', label: t('desktop.botWindow', { name: bot.name }) },
            { value: 'screen', label: t('desktop.screen') },
          ]}
          onChange={setShown}
        />
      )}
      {pc?.status === 'running' && shown === 'bot' ? (
        <BotBrowserView
          botId={bot.id}
          botName={bot.name}
          onShown={() => setShown('screen')}
          onTakeOver={inControl ? undefined : takeOver}
        />
      ) : pc?.status === 'running' ? (
        <Suspense fallback={null}>
          <DesktopView computerId={computerId} interactive={inControl} />
        </Suspense>
      ) : (
        <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed border-border-strong text-center text-sm text-muted-foreground">
          <div className="space-y-3">
            <p>{pc?.status === 'starting' ? t('chat.pcStarting') : t('chat.pcAsleep')}</p>
            {(pc?.status === 'stopped' || pc?.status === 'error') && (
              <Button size="sm" variant="outline" onClick={() => action.mutate('start')}>
                <Power className="size-3.5" /> {t('common.turnOn')}
              </Button>
            )}
          </div>
        </div>
      )}
      {pc?.status === 'running' && (
        <div className="flex flex-wrap items-center gap-2">
          {inControl ? (
            <Button size="sm" onClick={() => action.mutate('release')} disabled={action.isPending}>
              <Undo2 className="size-3.5" /> {t('desktop.release')}
            </Button>
          ) : (
            <Button size="sm" onClick={takeOver} disabled={action.isPending}>
              <Hand className="size-3.5" /> {t('desktop.takeover')}
            </Button>
          )}
          <Link
            to="/computers/$computerId"
            params={{ computerId }}
            className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Maximize2 className="size-3.5" /> {t('chat.openFull')}
          </Link>
        </div>
      )}
      <p className="text-xs text-faint">
        {inControl
          ? t('desktop.inControl')
          : control
            ? t('desktop.otherDevice')
            : t('chat.readOnly')}
      </p>
    </motion.aside>
  );
}

/** Conversation with a bot: the Chef on `/`, any bot on `/bots/$botId`. */
export function ChatPage() {
  const { t } = useTranslation();
  const { botId } = useParams({ strict: false }) as { botId?: string };
  const navigate = useNavigate();
  const chef = useChef();
  const byId = useBot(botId);
  const bot = botId ? byId.data : chef.data;
  const messages = useMessages(bot?.id);
  const questions = useQuestions();
  // Oldest first, like the conversation.
  const asked = (questions.data ?? []).filter((q) => q.botId === bot?.id).reverse();
  const providers = useProviders();
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const hydrated = useRef(false);
  const [showPc, setShowPc] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async ({ text, mentions }: { text: string; mentions?: Mention[] }) => {
      const { data, error } = await api.POST('/api/v1/bots/{id}/messages', {
        params: { path: { id: bot?.id as string } },
        body: mentions?.length ? { text, mentions } : { text },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: () => {
      stickToBottom.current = true;
      setError(null);
    },
    onSuccess: (message) => {
      queryClient.setQueryData<Message[]>(['messages', message.botId], (list) =>
        list && !list.some((m) => m.id === message.id) ? [...list, message] : list,
      );
    },
    onError: (err) => setError(problemMessage(err, t('chat.notSent'))),
  });

  // Follow the conversation while the user is at the bottom.
  const items = messages.data ?? [];
  const places = incomingPlaces(items);
  const lastLength = items.at(-1)?.parts.reduce((n, p) => n + ('text' in p ? p.text.length : 1), 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message arrives or grows
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: hydrated.current ? 'smooth' : 'auto' });
  }, [items.length, lastLength]);
  useEffect(() => {
    if (messages.isSuccess) hydrated.current = true;
  }, [messages.isSuccess]);

  if (!bot) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">
        {chef.isPending || byId.isPending ? t('common.loading') : t('chat.notFound')}
      </div>
    );
  }

  const live = items.at(-1)?.status === 'streaming' ? items.at(-1) : undefined;
  const mood = moodOf(bot, live);
  const noModel = providers.isSuccess && (providers.data.length === 0 || !bot.model);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6">
          <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
          <div className="min-w-0 flex-1">
            {renamingId === bot.id ? (
              <RenameField bot={bot} onDone={() => setRenamingId(null)} />
            ) : (
              <p
                className="truncate font-semibold leading-tight"
                onDoubleClick={() => setRenamingId(bot.id)}
              >
                {bot.name}
              </p>
            )}
            <p
              className={cn(
                'truncate text-[13px] text-muted-foreground',
                mood !== 'idle' && 'shimmer-text',
              )}
            >
              {bot.model ? `${statusLabel(bot, mood)} · ${bot.model}` : statusLabel(bot, mood)}
            </p>
          </div>
          {bot.computerId && (
            <Button
              variant={showPc ? 'outline' : 'ghost'}
              size="sm"
              onClick={() => setShowPc((v) => !v)}
              aria-pressed={showPc}
            >
              <Monitor className="size-4" />{' '}
              <span className="hidden sm:inline">{t('chat.viewPc')}</span>
            </Button>
          )}
          <BotMenu bot={bot} onRename={() => setRenamingId(bot.id)} />
        </header>

        <div
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
            {noModel && (
              <motion.div
                variants={reveal}
                initial="hidden"
                animate="shown"
                className="glass flex flex-wrap items-center gap-3 rounded-2xl p-4"
              >
                <Sparkles className="size-5 text-primary" />
                <p className="min-w-0 flex-1 text-sm">{t('chat.noModel', { name: bot.name })}</p>
                <Button size="sm" onClick={() => void navigate({ to: '/settings/models' })}>
                  {t('chat.connectModel')}
                </Button>
              </motion.div>
            )}
            {messages.isSuccess && items.length === 0 && (
              <EmptyState bot={bot} onPick={(text) => send.mutate({ text })} />
            )}
            <AnimatePresence initial={false}>
              {items.map((message) => {
                const place = places.get(message.id);
                return (
                  <motion.div
                    key={message.id}
                    variants={reveal}
                    initial={hydrated.current ? 'hidden' : false}
                    animate="shown"
                    layout="position"
                    transition={springs.soft}
                    // Further down a run of incoming messages: close to the one before.
                    className={cn(place && !place.run && '-mt-4')}
                  >
                    {message.role === 'user' ? (
                      place ? (
                        <IncomingMessage message={message} place={place} />
                      ) : (
                        <UserMessage message={message} />
                      )
                    ) : (
                      <BotMessage
                        message={message}
                        bot={bot}
                        onAnswer={() => {
                          stickToBottom.current = true;
                        }}
                        onShowPc={() => setShowPc(true)}
                      />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-3 pb-3 md:px-6 md:pb-5">
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
          <AnimatePresence initial={false}>
            {asked.map((question) => (
              <QuestionCard key={question.id} question={question} className="mb-2" />
            ))}
          </AnimatePresence>
          <ChatComposer
            bot={bot}
            onTogglePc={() => setShowPc((v) => !v)}
            onRename={() => setRenamingId(bot.id)}
            onSend={(text, mentions) => send.mutate({ text, mentions })}
          />
        </div>
      </div>

      <AnimatePresence>
        {showPc && bot.computerId && (
          <ComputerPanel
            key="pc"
            computerId={bot.computerId}
            bot={bot}
            onClose={() => setShowPc(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
