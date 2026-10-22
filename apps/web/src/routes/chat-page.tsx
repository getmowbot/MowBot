import type {
  AttachmentUpload,
  Bot,
  CanvasKind,
  Mention,
  Message,
  MessagePart,
  Problem,
} from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Hand,
  Maximize2,
  Monitor,
  PanelRightClose,
  Power,
  RotateCw,
  Sparkles,
  Undo2,
} from 'lucide-react';
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
import { type Talk, TalkDialog, TalkLine } from '../components/bot-talk';
import { CanvasBody } from '../components/canvas-body';
import { ChatComposer } from '../components/chat-composer';
import { StatusBadge } from '../components/computer-status';
import { Markdown } from '../components/markdown';
import {
  type AttachmentPart,
  type AudioPart,
  MessageAttachments,
  VoiceMessage,
} from '../components/message-attachments';
import { MissionBar, PlanCard } from '../components/mission';
import { QuestionCard } from '../components/question-card';
import { TakeoverCard } from '../components/takeover-card';
import { Button } from '../components/ui/button';
import { VaultRequestCard } from '../components/vault-request-card';
import { i18n } from '../i18n';
import { api, client, problemMessage } from '../lib/auth';
import { isBusy, moodOf, statusLabel } from '../lib/bot-mood';
import { mentionSegments } from '../lib/chat-input';
import {
  chipBots,
  type IncomingPlace,
  incomingPlaces,
  inReadingOrder,
  runSummary,
  senderOf,
  shortSummary,
  summaryOf,
} from '../lib/incoming';
import { reveal } from '../lib/motion';
import { useQuestions, useSeenInConversation } from '../lib/proactivity';
import {
  MESSAGES_PAGE,
  useBot,
  useBots,
  useChef,
  useComputer,
  useComputerAction,
  useEarlierMessages,
  useMe,
  useMessages,
  useProviders,
  useTeams,
} from '../lib/queries';
import { cn } from '../lib/utils';
import { type Recording, recordingName } from '../lib/voice';

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

/** Under an answer cut by the step limit; it goes on by itself, or the user resumes it. */
function StepLimitHint({ onContinue, resumed }: { onContinue?: () => void; resumed: boolean }) {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-2 text-xs text-faint">
      {resumed ? t('chat.stepLimitResumes') : t('chat.stepLimit')}
      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="rounded-full border border-border-strong px-2.5 py-0.5 text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
        >
          {t('chat.continue')}
        </button>
      )}
    </p>
  );
}

/** The hub telling the bot to go on after the step limit: a quiet line, not a message. */
function ResumeLine({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <p className="flex items-center justify-center gap-1.5 text-xs text-faint">
      <RotateCw className="size-3" /> {t('chat.resumed', { count })}
    </p>
  );
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

/** What another bot wrote: one line with its sender and the gist, the whole message a click away. */
function FromBotMessage({ message }: { message: Message }) {
  const { t } = useTranslation();
  const bots = useBots();
  const [open, setOpen] = useState(false);
  const chips = useMemo(() => chipBots(bots.data, message), [bots.data, message]);
  const sender = senderOf(message);
  const name = sender.kind === 'bot' ? sender.name : '';
  const bot = bots.data?.find((b) => b.id === message.fromBotId) ?? {
    id: null,
    name,
    avatarSeed: name,
  };
  const talk: Talk = {
    title: t(`chat.talk.from.${message.kind}`, { name: bot.name }),
    bot,
    text: message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    at: message.createdAt,
  };
  return (
    <div className="flex flex-col items-center gap-1.5">
      <TalkLine
        title={talk.title}
        bot={bot}
        summary={summaryOf(message)}
        onOpen={() => setOpen(true)}
        className="max-w-[92%]"
      />
      <TalkDialog talk={talk} chips={chips} open={open} onClose={() => setOpen(false)} />
      {message.steered && <SteeredHint />}
    </div>
  );
}

/**
 * What the user (a task) or a routine gave this bot: a soft bubble under a quiet line saying
 * what it is; another bot's message, a line opening it.
 */
function IncomingMessage({ message, place }: { message: Message; place: IncomingPlace }) {
  const bots = useBots();
  const chips = useMemo(() => chipBots(bots.data, message), [bots.data, message]);
  if (senderOf(message).kind === 'bot') return <FromBotMessage message={message} />;
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <div className="flex flex-col items-center gap-1.5">
      {place.run && <IncomingLine run={place.run} />}
      <div className="max-w-[92%] rounded-2xl bg-ink/[0.055] px-4 py-2.5">
        <Markdown text={text} bots={chips} className="text-[14px] text-foreground/85" />
      </div>
      {message.steered && <SteeredHint />}
    </div>
  );
}

/** What the user sent: a voice message, pictures and files, their text. */
function UserMessage({ message }: { message: Message }) {
  const text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const attachments = message.parts.filter((p): p is AttachmentPart => p.type === 'attachment');
  const audio = message.parts.find((p): p is AudioPart => p.type === 'audio');
  return (
    <div className="flex flex-col items-end gap-1.5">
      {audio && <VoiceMessage message={message} part={audio} />}
      {attachments.length > 0 && <MessageAttachments parts={attachments} />}
      {text && (
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
      )}
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
  | { kind: 'plan'; teamId: string; index: number }
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
    // The plan the bot showed: drawn live from its team (the call's output).
    if (part.type === 'tool' && part.toolName === 'show_plan' && part.state === 'done') {
      if (part.output) out.push({ kind: 'plan', teamId: part.output, index });
      return;
    }
    // What the user sends; never in an answer.
    if (part.type === 'attachment' || part.type === 'audio') return;
    const tail = out.at(-1);
    if (tail?.kind === 'activity') tail.parts.push(part);
    else out.push({ kind: 'activity', parts: [part], index });
  });
  return out;
}

/** An earlier answer to the user longer than this folds to its first sentence. */
const LONG_ANSWER = 900;

function BotMessage({
  message,
  bot,
  latest,
  resumed,
  onAnswer,
  onShowPc,
  onContinue,
}: {
  message: Message;
  bot: Bot;
  /** The last answer: never folded, the user reads it. */
  latest: boolean;
  /** Cut by the step limit, and the hub told the bot to go on. */
  resumed: boolean;
  /** The user pressed a card's button or answered a vault request: their answer follows. */
  onAnswer(): void;
  /** Opens the PC panel (to take control from a takeover card). */
  onShowPc(): void;
  /** Cut by the step limit and still the last answer: the user can tell the bot to go on. */
  onContinue?: () => void;
}) {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const streaming = message.status === 'streaming';
  const blocks = segments(message.parts);
  const empty = blocks.length === 0;
  // An answer to other bots or a routine, or an earlier long one: its first sentence, the rest
  // a click away.
  const said = blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n\n');
  const long = !latest && said.length > LONG_ANSWER;
  const gist = (message.autonomous || long) && !streaming ? shortSummary(said) : '';
  const foldable = gist !== '' && said.trim().length > gist.length + 40;
  const folded = foldable && !unfolded;
  const firstText = blocks.findIndex((b) => b.kind === 'text');
  const lastText = blocks.findLastIndex((b) => b.kind === 'text');
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
          if (block.kind === 'plan') {
            return <PlanCard key={`plan-${block.index}`} teamId={block.teamId} />;
          }
          if (block.kind === 'activity') {
            return (
              <ActivityGroup
                key={`activity-${block.index}`}
                parts={block.parts}
                live={streaming && last}
              />
            );
          }
          if (folded) {
            return i === firstText ? (
              <button
                key={`text-${block.index}`}
                type="button"
                onClick={() => setUnfolded(true)}
                className="group block max-w-full text-left text-[14.5px] leading-6 text-muted-foreground transition-colors duration-200 hover:text-foreground"
              >
                {gist}{' '}
                <span className="whitespace-nowrap text-faint transition-colors duration-200 group-hover:text-muted-foreground">
                  · {t('chat.readMore')}
                </span>
              </button>
            ) : null;
          }
          return (
            <Fragment key={`text-${block.index}`}>
              <Markdown text={block.text} className={cn(streaming && last && 'streaming')} />
              {foldable && i === lastText && (
                <button
                  type="button"
                  onClick={() => setUnfolded(false)}
                  className="text-xs text-faint transition-colors duration-200 hover:text-muted-foreground"
                >
                  {t('chat.readLess')}
                </button>
              )}
            </Fragment>
          );
        })}
        {message.status === 'error' && (
          <p className="rounded-xl border border-destructive/25 bg-destructive/[0.07] px-3 py-2 text-sm text-destructive">
            {failure(message)}
          </p>
        )}
        {message.status === 'stopped' && <p className="text-xs text-faint">{t('chat.stopped')}</p>}
        {message.status === 'done' && message.stepLimit && (
          <StepLimitHint onContinue={resumed ? undefined : onContinue} resumed={resumed} />
        )}
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
            className="rounded-full border border-border-strong bg-ink/[0.02] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-foreground"
          >
            {t(key)}
          </button>
        ))}
      </motion.div>
    </motion.div>
  );
}

/**
 * The third panel, right of the conversation: the bot's PC live and small (its screen, or its
 * own browser window), to watch it work or take control, then the team's mission. Docked on
 * wide screens, over the conversation on the others.
 */
function ComputerPanel({
  computerId,
  bot,
  teamId,
  onClose,
}: {
  computerId: string;
  bot: { id: string; name: string };
  /** The bot's team, whose mission shows under the PC. */
  teamId: string | null;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const computer = useComputer(computerId);
  const action = useComputerAction(computerId);
  const pc = computer.data;
  const me = useMe();
  const control = pc?.control;
  const inControl = Boolean(control && control.deviceId === me.data?.device.id);
  // The desktop first; the bot browses in its own window, which the screen doesn't show.
  const [shown, setShown] = useState<'bot' | 'screen'>('screen');
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
      className="glass fixed inset-x-3 bottom-3 top-16 z-40 flex flex-col gap-3 overflow-y-auto rounded-2xl p-3 xl:static xl:inset-auto xl:z-auto xl:w-[24rem] xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:p-4 2xl:w-[28rem]"
    >
      <div className="flex items-center gap-2">
        <Monitor className="size-4 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{pc?.name ?? 'PC'}</span>
        {pc && <StatusBadge status={pc.status} />}
        <Link
          to="/computers/$computerId"
          params={{ computerId }}
          className="grid size-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-ink/[0.06] hover:text-foreground"
          title={t('chat.openFull')}
          aria-label={t('chat.openFull')}
        >
          <Maximize2 className="size-4" />
        </Link>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={t('chat.panel.hide')}
          title={t('chat.panel.hide')}
        >
          <PanelRightClose className="size-4" />
        </Button>
      </div>
      {pc?.status === 'running' && pc.system === 'desktop' && (
        <ViewSwitch
          value={shown}
          options={[
            { value: 'bot', label: t('desktop.botWindow', { name: bot.name }) },
            { value: 'screen', label: t('desktop.screen') },
          ]}
          onChange={setShown}
        />
      )}
      {pc?.status === 'running' && pc.system === 'terminal' && (
        <p className="text-xs text-muted-foreground">{t('computer.setup.noScreen')}</p>
      )}
      {pc?.status === 'running' && (shown === 'bot' || pc.system === 'terminal') ? (
        <BotBrowserView
          botId={bot.id}
          botName={bot.name}
          onShown={() => setShown('screen')}
          onTakeOver={inControl || pc.system === 'terminal' ? undefined : takeOver}
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
      {pc?.status === 'running' && pc.system === 'desktop' && (
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
          <p className="min-w-0 flex-1 text-xs text-faint">
            {inControl
              ? t('desktop.inControl')
              : control
                ? t('desktop.otherDevice')
                : t('chat.readOnly')}
          </p>
        </div>
      )}
      {teamId && <PlanCard teamId={teamId} optional className="mt-2 max-w-none" />}
    </motion.aside>
  );
}

/** Where the third panel docks: wide screens (Tailwind's xl). */
const WIDE = '(min-width: 1280px)';
const PANEL_KEY = 'mowbot.desktopPanel';

function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const query = matchMedia(WIDE);
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** Docked unless the user hid it (kept on this device). */
function panelDocked(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

function dockPanel(shown: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, shown ? 'shown' : 'hidden');
  } catch {
    // Kept for this visit only.
  }
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
  const earlier = useEarlierMessages(bot?.id);
  const { load } = earlier;
  // How many of the last messages are drawn: more as the user scrolls up, back down at the end.
  const [shown, setShown] = useState(MESSAGES_PAGE);
  const questions = useQuestions();
  // Being here is seeing what this bot notified.
  useSeenInConversation(bot?.id);
  // Oldest first, like the conversation.
  const asked = (questions.data ?? []).filter((q) => q.botId === bot?.id).reverse();
  const providers = useProviders();
  const teams = useTeams();
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const hydrated = useRef(false);
  const wide = useWide();
  const [docked, setDocked] = useState(panelDocked);
  const [overlay, setOverlay] = useState(false);
  const showPc = wide ? docked : overlay;
  const setShowPc = (next: boolean | ((shown: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(showPc) : next;
    if (wide) {
      setDocked(value);
      dockPanel(value);
    } else setOverlay(value);
  };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const added = (message: Message) =>
    queryClient.setQueryData<Message[]>(['messages', message.botId], (list) =>
      list && !list.some((m) => m.id === message.id) ? [...list, message] : list,
    );

  const send = useMutation({
    mutationFn: async ({
      text,
      mentions,
      files,
    }: {
      text: string;
      mentions?: Mention[];
      files?: File[];
    }) => {
      const id = bot?.id as string;
      // Files go first, into the bot's inbox; the message then points at them.
      let attachments: { path: string }[] | undefined;
      if (files?.length) {
        const form = new FormData();
        for (const file of files) form.append('file', file, file.name);
        const response = await client.fetch(`/api/v1/bots/${id}/attachments`, {
          method: 'POST',
          body: form,
        });
        if (!response.ok) throw await response.json().catch(() => null);
        const uploaded = (await response.json()) as AttachmentUpload;
        attachments = uploaded.items.map((item) => ({ path: item.path }));
      }
      const { data, error } = await api.POST('/api/v1/bots/{id}/messages', {
        params: { path: { id } },
        body: {
          text,
          ...(mentions?.length ? { mentions } : {}),
          ...(attachments ? { attachments } : {}),
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: () => {
      stickToBottom.current = true;
      setError(null);
    },
    onSuccess: added,
    onError: (err) => setError(problemMessage(err, t('chat.notSent'))),
  });

  /** A voice message: shown at once, its transcript follows (`message.updated`). */
  const sendVoice = useMutation({
    mutationFn: async (recording: Recording) => {
      const form = new FormData();
      form.append('durationMs', String(recording.durationMs));
      form.append('peaks', recording.peaks.join(','));
      form.append('file', recording.blob, recordingName(recording.mimeType));
      const response = await client.fetch(`/api/v1/bots/${bot?.id as string}/messages/voice`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw await response.json().catch(() => null);
      return (await response.json()) as Message;
    },
    onMutate: () => {
      stickToBottom.current = true;
      setError(null);
    },
    onSuccess: added,
    onError: (err) => setError(problemMessage(err, t('chat.voice.notSent'))),
  });

  const all = useMemo(() => inReadingOrder(messages.data ?? []), [messages.data]);
  const items = all.length > shown ? all.slice(-shown) : all;
  const places = incomingPlaces(items);
  const hasEarlier = items.length < all.length || earlier.more;

  // Another conversation: from its end again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the bot changes
  useEffect(() => setShown(MESSAGES_PAGE), [bot?.id]);

  // Scrolled up to the top: draw earlier messages (loading them if needed), where they were.
  const fromBottom = useRef<number | null>(null);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = top.current;
    const root = scroller.current;
    if (!el || !root || !hasEarlier) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || fromBottom.current !== null || earlier.loading) return;
        fromBottom.current = root.scrollHeight - root.scrollTop;
        if (items.length < all.length) setShown((n) => n + MESSAGES_PAGE);
        else
          void load()
            .then(() => {
              setShown((n) => n + MESSAGES_PAGE);
              // Nothing came (the start was reached): nothing to put back in place.
              requestAnimationFrame(() => {
                fromBottom.current = null;
              });
            })
            .catch(() => {
              fromBottom.current = null;
            });
      },
      { root, rootMargin: '400px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasEarlier, items.length, all.length, earlier.loading, load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the earlier messages are drawn
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root || fromBottom.current === null) return;
    root.scrollTop = root.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [items[0]?.id]);

  // Follow the conversation while the user is at the bottom.
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
  const latestAnswer = items.findLast((m) => m.role === 'assistant')?.id;
  const mood = moodOf(bot, live);
  const noModel = providers.isSuccess && (providers.data.length === 0 || !bot.model);
  // What it is doing · its role · its team (the model is in its settings).
  const status = statusLabel(bot, live);
  const team = teams.data?.find((candidate) => candidate.id === bot.teamId);
  const about = [bot.role, team?.name].filter(Boolean).join(' · ');

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 md:px-6 [.desktop-frameless_&]:pr-36">
          <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
          <div className="min-w-0 flex-1">
            {renamingId === bot.id ? (
              <RenameField bot={bot} onDone={() => setRenamingId(null)} />
            ) : (
              <p
                className="truncate font-semibold leading-tight"
                onDoubleClick={() => setRenamingId(bot.id)}
                data-no-drag
              >
                {bot.name}
              </p>
            )}
            <p
              title={[bot.focus, status, about].filter(Boolean).join(' · ')}
              className="flex min-w-0 text-[13px] text-muted-foreground"
            >
              <span className={cn('max-w-[65%] shrink-0 truncate', isBusy(bot) && 'shimmer-text')}>
                {status}
              </span>
              <span className="min-w-0 truncate">
                <span className="px-1.5 text-faint">·</span>
                {about}
              </span>
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
        {team && <MissionBar team={team} />}

        <div
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
            // Back at the end: the earlier messages scrolled through are let go.
            if (stickToBottom.current && shown > MESSAGES_PAGE) setShown(MESSAGES_PAGE);
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
            {hasEarlier && (
              <div ref={top} className="-mb-3 text-center text-xs text-faint">
                {earlier.loading ? t('common.loading') : null}
              </div>
            )}
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
              {items.map((message, index) => {
                const place = places.get(message.id);
                return (
                  <motion.div
                    key={message.id}
                    variants={reveal}
                    // New messages arrive at the end; earlier ones show up still, as they were.
                    initial={hydrated.current && index >= items.length - 2 ? 'hidden' : false}
                    animate="shown"
                    // Measuring every message at each streamed word weighs on long conversations.
                    layout={index >= items.length - 3 ? 'position' : false}
                    transition={springs.soft}
                    // Further down a run of incoming messages: close to the one before.
                    className={cn(place && !place.run && '-mt-4')}
                  >
                    {message.resume ? (
                      <ResumeLine count={message.resume} />
                    ) : message.role === 'user' ? (
                      place ? (
                        <IncomingMessage message={message} place={place} />
                      ) : (
                        <UserMessage message={message} />
                      )
                    ) : (
                      <BotMessage
                        message={message}
                        bot={bot}
                        latest={message.id === latestAnswer}
                        resumed={Boolean(items[index + 1]?.resume)}
                        onAnswer={() => {
                          stickToBottom.current = true;
                        }}
                        onShowPc={() => setShowPc(true)}
                        onContinue={
                          index === items.length - 1 && !send.isPending
                            ? () => send.mutate({ text: 'Continue' })
                            : undefined
                        }
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
          {send.isPending && Boolean(send.variables?.files?.length) && (
            <p className="shimmer-text mb-2 text-sm">{t('chat.attach.uploading')}</p>
          )}
          <AnimatePresence initial={false}>
            {asked.map((question) => (
              <QuestionCard key={question.id} question={question} className="mb-2" />
            ))}
          </AnimatePresence>
          <ChatComposer
            bot={bot}
            onTogglePc={() => setShowPc((v) => !v)}
            onRename={() => setRenamingId(bot.id)}
            onSend={(text, mentions, files) => send.mutateAsync({ text, mentions, files })}
            onSendVoice={(recording) => sendVoice.mutateAsync(recording)}
          />
        </div>
      </div>

      <AnimatePresence>
        {showPc && bot.computerId && (
          <ComputerPanel
            key="pc"
            computerId={bot.computerId}
            bot={bot}
            teamId={bot.teamId}
            onClose={() => setShowPc(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
