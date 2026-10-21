import type { MessagePart } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import {
  AlarmClock,
  AppWindow,
  ArrowRightLeft,
  Bell,
  Brain,
  BrushCleaning,
  CalendarClock,
  CalendarX,
  Camera,
  Check,
  ChevronDown,
  ClipboardList,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  ListPlus,
  Lock,
  LockOpen,
  type LucideIcon,
  Maximize2,
  MessageCircleQuestion,
  Monitor,
  MousePointer2,
  MousePointerClick,
  Search,
  Send,
  SquareTerminal,
  TextCursorInput,
  Undo2,
  UserPen,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { shortSummary } from '../lib/incoming';
import { useBots } from '../lib/queries';
import { cn } from '../lib/utils';
import { chipsOf, type Talk, TalkDialog } from './bot-talk';
import { useWorkspaceFileUrl } from './markdown-document';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type ReasoningPart = Extract<MessagePart, { type: 'reasoning' }>;
/** What a bot does between two things it says: tool calls and reasoning. */
export type ActivityPart = ToolPart | ReasoningPart;
type Input = Record<string, unknown>;

const str = (value: unknown) => (typeof value === 'string' ? value : '');

const workspacePath = (value: unknown) => str(value).replace(/^\/workspace\/?/, '') || 'workspace';

const SEARCH_HOST =
  /(^|\.)(google\.[a-z.]+|duckduckgo\.com|bing\.com|qwant\.com|search\.brave\.com)$/;

function searchQuery(value: unknown): string | null {
  try {
    const url = new URL(str(value));
    return SEARCH_HOST.test(url.hostname) ? url.searchParams.get('q') : null;
  } catch {
    return null;
  }
}

function describeUrl(value: unknown): string {
  const query = searchQuery(value);
  if (query) return i18n.t('activity.search', { query });
  try {
    return i18n.t('activity.open', {
      target: new URL(str(value)).hostname.replace(/^www\./, ''),
    });
  } catch {
    return i18n.t('activity.open', { target: str(value) });
  }
}

/** `Écrit à Nova · La playlist est prête`: to whom, and the gist the bot gave (or its first sentence). */
function talkTitle(
  key: 'activity.sendMessage' | 'activity.askBot',
  input: Input,
  text: unknown,
): string {
  const who = i18n.t(key, { name: str(input.to) });
  const gist = str(input.summary).trim() || shortSummary(str(text));
  return gist ? `${who} · ${gist}` : who;
}

/** `cd /tmp && curl -sL …` → `Lance curl` / `Running curl`. */
function describeCommand(value: unknown): string {
  const step = str(value)
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^(cd|export|set)\b/.test(s));
  const program = step
    ?.replace(/^(sudo|nohup|env|time)\s+/, '')
    .split(/\s+/)[0]
    ?.split('/')
    .at(-1);
  return program ? i18n.t('activity.run', { program }) : i18n.t('activity.runAny');
}

function describeComputer(input: Input): string {
  const { t } = i18n;
  const at = typeof input.x === 'number' ? ` (${input.x}, ${input.y})` : '';
  switch (input.action) {
    case 'click':
      return t('activity.click', { at });
    case 'double_click':
      return t('activity.doubleClick', { at });
    case 'right_click':
      return t('activity.rightClick', { at });
    case 'move':
      return t('activity.move', { at });
    case 'type':
      return t('activity.type', { text: str(input.text).slice(0, 60) });
    case 'key':
      return t('activity.keys', { keys: str(input.keys) });
    case 'scroll':
      return t(input.direction === 'up' ? 'activity.scrollUp' : 'activity.scrollDown');
    case 'drag':
      return t('activity.drag', { at, x: String(input.to_x), y: String(input.to_y) });
    default:
      return t('activity.screenAny');
  }
}

/** Categories counted in the summary of a finished activity. */
type Kind =
  | 'search'
  | 'page'
  | 'web'
  | 'capture'
  | 'command'
  | 'screen'
  | 'write'
  | 'read'
  | 'tidy'
  | 'message'
  | 'question'
  | 'task'
  | 'created'
  | 'routine'
  | 'canvas'
  | 'notified';

const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done', 'cancelled'] as const;
const isTaskStatus = (value: string): value is (typeof TASK_STATUSES)[number] =>
  (TASK_STATUSES as readonly string[]).includes(value);

interface ToolMeta {
  icon(input: Input): LucideIcon;
  title(input: Input): string;
  kind(input: Input): Kind | null;
}

const openPage: ToolMeta = {
  icon: (i) => (searchQuery(i.url) ? Search : Globe),
  title: (i) => describeUrl(i.url),
  kind: (i) => (searchQuery(i.url) ? 'search' : 'page'),
};

const TOOLS: Record<string, ToolMeta> = {
  bash: {
    icon: () => SquareTerminal,
    title: (i) => describeCommand(i.command),
    kind: () => 'command',
  },
  read_file: {
    icon: () => FileText,
    title: (i) => i18n.t('activity.readFile', { path: workspacePath(i.path) }),
    kind: () => 'read',
  },
  write_file: {
    icon: () => FilePen,
    title: (i) => i18n.t('activity.writeFile', { path: workspacePath(i.path) }),
    kind: () => 'write',
  },
  list_files: {
    icon: () => FolderOpen,
    title: (i) => i18n.t('activity.listFiles', { path: workspacePath(i.path) }),
    kind: () => 'read',
  },
  browser_open: openPage,
  // Conversations from before the bots had their own browser window.
  open_url: openPage,
  browser_snapshot: {
    icon: () => FileText,
    title: () => i18n.t('activity.browserSnapshot'),
    kind: () => null,
  },
  browser_click: {
    icon: () => MousePointerClick,
    title: (i) => i18n.t('activity.browserClick', { ref: String(i.ref ?? '?') }),
    kind: () => 'web',
  },
  browser_type: {
    icon: () => TextCursorInput,
    title: (i) => i18n.t('activity.type', { text: str(i.text).slice(0, 60) }),
    kind: () => 'web',
  },
  browser_select: {
    icon: () => ListChecks,
    title: (i) => i18n.t('activity.browserSelect', { option: str(i.option) }),
    kind: () => 'web',
  },
  browser_press: {
    icon: () => Keyboard,
    title: (i) => i18n.t('activity.keys', { keys: str(i.key) }),
    kind: () => 'web',
  },
  browser_scroll: {
    icon: () => MousePointer2,
    title: (i) => i18n.t(i.direction === 'up' ? 'activity.scrollUp' : 'activity.scrollDown'),
    kind: () => null,
  },
  browser_back: {
    icon: () => Undo2,
    title: () => i18n.t('activity.browserBack'),
    kind: () => 'web',
  },
  browser_screenshot: {
    icon: () => Camera,
    title: () => i18n.t('activity.browserScreenshot'),
    kind: () => 'capture',
  },
  screenshot: {
    icon: () => Camera,
    title: () => i18n.t('activity.screenshot'),
    kind: () => 'capture',
  },
  computer: { icon: () => MousePointer2, title: describeComputer, kind: () => 'screen' },
  list_windows: {
    icon: () => AppWindow,
    title: () => i18n.t('activity.listWindows'),
    kind: () => null,
  },
  close_windows: {
    icon: () => BrushCleaning,
    title: (i) =>
      Array.isArray(i.ids) && i.ids.length > 0
        ? i18n.t('activity.closeWindows', { count: i.ids.length })
        : i18n.t('activity.tidy'),
    kind: () => 'tidy',
  },
  pc_status: {
    icon: () => Monitor,
    title: () => i18n.t('activity.pcStatus'),
    kind: () => null,
  },
  lock_file: {
    icon: () => Lock,
    title: (i) => i18n.t('activity.lockFile', { path: workspacePath(i.path) }),
    kind: () => null,
  },
  unlock_file: {
    icon: () => LockOpen,
    title: (i) => i18n.t('activity.unlockFile', { path: workspacePath(i.path) }),
    kind: () => null,
  },
  list_bots: { icon: () => Users, title: () => i18n.t('activity.listBots'), kind: () => null },
  send_message: {
    icon: () => Send,
    title: (i) => talkTitle('activity.sendMessage', i, i.text),
    kind: () => 'message',
  },
  share_file: {
    icon: () => Send,
    title: (i) => i18n.t('activity.shareFile', { path: workspacePath(i.path), name: str(i.to) }),
    kind: () => 'message',
  },
  move_bot: {
    icon: () => ArrowRightLeft,
    title: (i) => i18n.t('activity.moveBot', { name: str(i.bot), team: str(i.team) }),
    kind: () => null,
  },
  ask_user: {
    icon: () => MessageCircleQuestion,
    title: () => i18n.t('activity.askUser'),
    kind: () => 'question',
  },
  ask_bot: {
    icon: () => MessageCircleQuestion,
    title: (i) => talkTitle('activity.askBot', i, i.question),
    kind: () => 'question',
  },
  assign_task: {
    icon: () => ListPlus,
    title: (i) => i18n.t('activity.assignTask', { title: str(i.title), name: str(i.to) }),
    kind: () => 'task',
  },
  update_task: {
    icon: () => ListChecks,
    title: (i) => {
      const status = str(i.status);
      return isTaskStatus(status)
        ? i18n.t('activity.updateTask', { status: i18n.t(`activity.taskStatus.${status}`) })
        : i18n.t('activity.updateTaskAny');
    },
    kind: () => null,
  },
  list_tasks: {
    icon: () => ListChecks,
    title: () => i18n.t('activity.listTasks'),
    kind: () => null,
  },
  create_team: {
    icon: () => Users,
    title: (i) => i18n.t('activity.createTeam', { name: str(i.name) }),
    kind: () => 'created',
  },
  create_bot: {
    icon: () => UserPlus,
    title: (i) => i18n.t('activity.createBot', { name: str(i.name) }),
    kind: () => 'created',
  },
  update_bot: {
    icon: () => UserPen,
    title: (i) => i18n.t('activity.updateBot', { name: str(i.bot) }),
    kind: () => null,
  },
  create_routine: {
    icon: () => CalendarClock,
    title: (i) => i18n.t('activity.createRoutine', { name: str(i.name) }),
    kind: () => 'routine',
  },
  list_routines: {
    icon: () => CalendarClock,
    title: () => i18n.t('activity.listRoutines'),
    kind: () => null,
  },
  update_routine: {
    icon: () => CalendarClock,
    title: () => i18n.t('activity.updateRoutine'),
    kind: () => null,
  },
  delete_routine: {
    icon: () => CalendarX,
    title: () => i18n.t('activity.deleteRoutine'),
    kind: () => null,
  },
  set_heartbeat: {
    icon: () => AlarmClock,
    title: (i) =>
      i18n.t(typeof i.minutes === 'number' ? 'activity.setHeartbeat' : 'activity.heartbeatOff'),
    kind: () => null,
  },
  notify_user: {
    icon: () => Bell,
    title: (i) => i18n.t('activity.notifyUser', { title: str(i.title) }),
    kind: () => 'notified',
  },
  activity_report: {
    icon: () => ClipboardList,
    title: () => i18n.t('activity.activityReport'),
    kind: () => null,
  },
  canvas_set: {
    icon: () => LayoutDashboard,
    title: (i) => i18n.t('activity.canvasSet', { title: str(i.title) }),
    kind: () => 'canvas',
  },
  canvas_get: {
    icon: () => LayoutDashboard,
    title: () => i18n.t('activity.canvasGet'),
    kind: () => null,
  },
  canvas_list: {
    icon: () => LayoutDashboard,
    title: () => i18n.t('activity.canvasList'),
    kind: () => null,
  },
  canvas_remove: {
    icon: () => LayoutDashboard,
    title: () => i18n.t('activity.canvasRemove'),
    kind: () => null,
  },
};

const FALLBACK: ToolMeta = { icon: () => Wrench, title: () => '', kind: () => null };

function toolIcon(part: ToolPart): LucideIcon {
  return (TOOLS[part.toolName] ?? FALLBACK).icon(input(part));
}

const input = (part: ToolPart) => (part.input ?? {}) as Input;

/** What the bot says it is doing (`intent`), or a label derived from the call. */
function toolTitle(part: ToolPart): string {
  const intent = str(input(part).intent).trim();
  if (intent) return intent;
  return (TOOLS[part.toolName] ?? FALLBACK).title(input(part)) || part.toolName;
}

/** `2 recherches · 1 page · 5 captures`, in the app's language. */
function summarize(tools: ToolPart[]): string {
  const counts = new Map<Kind, number>();
  for (const part of tools) {
    const kind = (TOOLS[part.toolName] ?? FALLBACK).kind(input(part));
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const words = [...counts].map(([kind, count]) => i18n.t(`activity.summary.${kind}`, { count }));
  if (words.length === 0) return i18n.t('activity.summary.actions', { count: tools.length });
  return words.join(' · ');
}

function Screenshot({ workspaceId, path }: { workspaceId: string; path: string }) {
  const { t } = useTranslation();
  const image = useWorkspaceFileUrl(workspaceId, path);
  if (!image.url)
    return <div className="aspect-[16/10] w-full animate-pulse rounded-lg bg-white/[0.04]" />;
  return (
    <img
      src={image.url}
      alt={t('activity.screenshotAlt')}
      className="w-full rounded-lg border border-border"
    />
  );
}

const expand = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: springs.soft,
};

/** The hub's words before a question's answer, in the tool's output. */
const ANSWER_PREFIX = /^Réponse de [^\n]*:\n/;

/** A message or a question to another bot: opens large, with what came back. */
function TalkStep({ part }: { part: ToolPart }) {
  const { t } = useTranslation();
  const bots = useBots();
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part);
  const i = input(part);
  const asks = part.toolName === 'ask_bot';
  const name = str(i.to).trim();
  const bot = bots.data?.find(
    (b) => b.id === name || b.name.toLowerCase() === name.toLowerCase(),
  ) ?? { id: null, name, avatarSeed: name };
  const output = part.state === 'running' ? '' : (part.output ?? '');
  const talk: Talk = {
    title: t(asks ? 'chat.talk.to.ask' : 'chat.talk.to.chat', { name: bot.name }),
    bot,
    text: str(asks ? i.question : i.text),
    // A message only gets "sent"; a question its answer, or why none came.
    answer:
      output && (asks || part.state === 'error')
        ? {
            title: ANSWER_PREFIX.test(output)
              ? t('chat.talk.answerFrom', { name: bot.name })
              : t('chat.talk.outcome'),
            text: output.replace(ANSWER_PREFIX, ''),
          }
        : undefined,
  };
  return (
    <li>
      <button
        type="button"
        disabled={!talk.text}
        onClick={() => setOpen(true)}
        className="group flex max-w-full items-center gap-2 py-0.5 text-left text-faint transition-colors duration-200 enabled:hover:text-muted-foreground disabled:cursor-default"
      >
        <Icon className={cn('size-3.5 shrink-0', part.state === 'error' && 'text-destructive')} />
        <span className={cn('truncate', part.state === 'running' && 'shimmer-text')}>
          {toolTitle(part)}
        </span>
        <Maximize2 className="size-3 shrink-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      </button>
      <TalkDialog
        talk={talk}
        chips={chipsOf(bots.data)}
        open={open}
        onClose={() => setOpen(false)}
      />
    </li>
  );
}

const isTalk = (part: ToolPart) => part.toolName === 'send_message' || part.toolName === 'ask_bot';

function ToolStep({ part }: { part: ToolPart }) {
  useTranslation(); // re-render the labels when the language changes
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(part);
  const intent = str(input(part).intent).trim();
  // With an intent as title, the mechanical label (click coordinates…) goes into the details.
  const mechanical = intent ? (TOOLS[part.toolName] ?? FALLBACK).title(input(part)) : '';
  const hasDetails = Boolean(part.output || part.image || mechanical);
  return (
    <li>
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setOpen((v) => !v)}
        className="group flex max-w-full items-center gap-2 py-0.5 text-left text-faint transition-colors duration-200 enabled:hover:text-muted-foreground disabled:cursor-default"
      >
        <Icon className={cn('size-3.5 shrink-0', part.state === 'error' && 'text-destructive')} />
        <span className={cn('truncate', part.state === 'running' && 'shimmer-text')}>
          {toolTitle(part)}
        </span>
        {hasDetails && (
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-300 group-hover:opacity-100',
              open && 'rotate-180 opacity-100',
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetails && (
          <motion.div {...expand} className="overflow-hidden">
            <div className="space-y-2 pb-2 pl-[22px] pt-1">
              {mechanical && <p className="font-mono text-[12px] text-faint">{mechanical}</p>}
              {part.image && (
                <Screenshot workspaceId={part.image.workspaceId} path={part.image.path} />
              )}
              {part.output && !part.image && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white/[0.03] p-2.5 font-mono text-[12px] leading-relaxed text-muted-foreground">
                  {part.output}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function ReasoningStep({ part }: { part: ReasoningPart }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full gap-2 py-0.5 text-left text-faint transition-colors duration-200 hover:text-muted-foreground"
      >
        <Brain className="mt-[3px] size-3.5 shrink-0" />
        <span className={cn('whitespace-pre-wrap italic', !open && 'line-clamp-2')}>
          {part.text.trim()}
        </span>
      </button>
    </li>
  );
}

/**
 * A run of actions as one grey line, quieter than what the bot says: what it is doing right
 * now while it works, a summary once done. Opens on the history, each step expandable.
 */
export function ActivityGroup({ parts, live }: { parts: ActivityPart[]; live: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tools = parts.filter((p): p is ToolPart => p.type === 'tool');
  const steps = parts.filter((p) => p.type === 'tool' || p.text.trim());
  if (steps.length === 0 && !live) return null;

  const running = tools.findLast((p) => p.state === 'running');
  const errors = tools.filter((p) => p.state === 'error').length;
  const title = live
    ? running
      ? toolTitle(running)
      : t('activity.thinking')
    : tools.length > 0
      ? summarize(tools)
      : t('activity.reasoning');
  const Icon = running ? toolIcon(running) : live || tools.length === 0 ? Brain : Check;

  return (
    <div className="text-[13px]">
      <button
        type="button"
        disabled={steps.length === 0}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex max-w-full items-center gap-2 py-0.5 text-left text-faint transition-colors duration-200 enabled:hover:text-muted-foreground disabled:cursor-default"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={Icon.displayName ?? title}
            initial={{ opacity: 0, scale: 0.6, filter: 'blur(3px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.6, filter: 'blur(3px)' }}
            transition={springs.snappy}
            className="shrink-0"
          >
            <Icon className="size-3.5" />
          </motion.span>
        </AnimatePresence>
        <span className="relative min-w-0 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={title}
              initial={{ y: 10, opacity: 0, filter: 'blur(4px)' }}
              animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
              exit={{ y: -10, opacity: 0, filter: 'blur(4px)' }}
              transition={springs.snappy}
              className={cn('block truncate leading-5', live && 'shimmer-text')}
            >
              {title}
            </motion.span>
          </AnimatePresence>
        </span>
        {!live && errors > 0 && (
          <span className="shrink-0 text-destructive/80">
            · {t('activity.failures', { count: errors })}
          </span>
        )}
        {steps.length > 0 && (
          <ChevronDown
            className={cn(
              'size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-300 group-hover:opacity-100',
              open && 'rotate-180 opacity-100',
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...expand} className="overflow-hidden">
            <ul className="ml-[6.5px] mt-1 space-y-0.5 border-l border-border pl-3">
              {steps.map((part, index) =>
                part.type === 'tool' ? (
                  isTalk(part) ? (
                    <TalkStep key={part.toolCallId} part={part} />
                  ) : (
                    <ToolStep key={part.toolCallId} part={part} />
                  )
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: reasoning parts only ever append
                  <ReasoningStep key={`reasoning-${index}`} part={part} />
                ),
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
