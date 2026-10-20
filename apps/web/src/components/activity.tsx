import type { MessagePart } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useQuery } from '@tanstack/react-query';
import {
  AppWindow,
  Brain,
  BrushCleaning,
  Camera,
  Check,
  ChevronDown,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  ListPlus,
  Lock,
  LockOpen,
  type LucideIcon,
  MessageCircleQuestion,
  Monitor,
  MousePointer2,
  Search,
  Send,
  SquareTerminal,
  UserPen,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { client } from '../lib/auth';
import { cn } from '../lib/utils';

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
  if (query) return `Cherche « ${query} »`;
  try {
    return `Ouvre ${new URL(str(value)).hostname.replace(/^www\./, '')}`;
  } catch {
    return `Ouvre ${str(value)}`;
  }
}

/** `cd /tmp && curl -sL …` → `Lance curl`. */
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
  return program ? `Lance ${program}` : 'Lance une commande';
}

function describeComputer(input: Input): string {
  const at = typeof input.x === 'number' ? ` (${input.x}, ${input.y})` : '';
  switch (input.action) {
    case 'click':
      return `Clic${at}`;
    case 'double_click':
      return `Double clic${at}`;
    case 'right_click':
      return `Clic droit${at}`;
    case 'move':
      return `Déplace la souris${at}`;
    case 'type':
      return `Tape « ${str(input.text).slice(0, 60)} »`;
    case 'key':
      return `Touches ${str(input.keys)}`;
    case 'scroll':
      return `Défile vers ${input.direction === 'up' ? 'le haut' : 'le bas'}`;
    case 'drag':
      return `Glisse${at} → (${input.to_x}, ${input.to_y})`;
    default:
      return 'Agit à l’écran';
  }
}

/** Categories counted in the summary of a finished activity. */
type Kind =
  | 'search'
  | 'page'
  | 'capture'
  | 'command'
  | 'screen'
  | 'write'
  | 'read'
  | 'tidy'
  | 'message'
  | 'question'
  | 'task'
  | 'created';

const NOUNS: Record<Kind, [string, string]> = {
  search: ['recherche', 'recherches'],
  page: ['page', 'pages'],
  capture: ['capture', 'captures'],
  command: ['commande', 'commandes'],
  screen: ['action à l’écran', 'actions à l’écran'],
  write: ['fichier écrit', 'fichiers écrits'],
  read: ['lecture', 'lectures'],
  tidy: ['rangement', 'rangements'],
  message: ['message', 'messages'],
  question: ['question', 'questions'],
  task: ['tâche', 'tâches'],
  created: ['création', 'créations'],
};

const TASK_STATUSES: Record<string, string> = {
  todo: 'à faire',
  doing: 'en cours',
  blocked: 'bloquée',
  done: 'terminée',
  cancelled: 'annulée',
};

interface ToolMeta {
  icon(input: Input): LucideIcon;
  title(input: Input): string;
  kind(input: Input): Kind | null;
}

const TOOLS: Record<string, ToolMeta> = {
  bash: {
    icon: () => SquareTerminal,
    title: (i) => describeCommand(i.command),
    kind: () => 'command',
  },
  read_file: {
    icon: () => FileText,
    title: (i) => `Lit ${workspacePath(i.path)}`,
    kind: () => 'read',
  },
  write_file: {
    icon: () => FilePen,
    title: (i) => `Écrit ${workspacePath(i.path)}`,
    kind: () => 'write',
  },
  list_files: {
    icon: () => FolderOpen,
    title: (i) => `Parcourt ${workspacePath(i.path)}`,
    kind: () => 'read',
  },
  open_url: {
    icon: (i) => (searchQuery(i.url) ? Search : Globe),
    title: (i) => describeUrl(i.url),
    kind: (i) => (searchQuery(i.url) ? 'search' : 'page'),
  },
  screenshot: { icon: () => Camera, title: () => 'Regarde l’écran', kind: () => 'capture' },
  computer: { icon: () => MousePointer2, title: describeComputer, kind: () => 'screen' },
  list_windows: {
    icon: () => AppWindow,
    title: () => 'Regarde ce qui est ouvert',
    kind: () => null,
  },
  close_windows: {
    icon: () => BrushCleaning,
    title: (i) =>
      Array.isArray(i.ids) && i.ids.length > 0
        ? `Ferme ${i.ids.length} onglet${i.ids.length > 1 ? 's' : ''} ou fenêtre${i.ids.length > 1 ? 's' : ''}`
        : 'Range ce qu’il a ouvert',
    kind: () => 'tidy',
  },
  pc_status: {
    icon: () => Monitor,
    title: () => 'Regarde qui fait quoi sur le PC',
    kind: () => null,
  },
  lock_file: {
    icon: () => Lock,
    title: (i) => `Réserve ${workspacePath(i.path)}`,
    kind: () => null,
  },
  unlock_file: {
    icon: () => LockOpen,
    title: (i) => `Libère ${workspacePath(i.path)}`,
    kind: () => null,
  },
  list_bots: { icon: () => Users, title: () => 'Consulte l’annuaire', kind: () => null },
  send_message: {
    icon: () => Send,
    title: (i) => `Écrit à ${str(i.to)}`,
    kind: () => 'message',
  },
  ask_bot: {
    icon: () => MessageCircleQuestion,
    title: (i) => `Demande à ${str(i.to)}`,
    kind: () => 'question',
  },
  assign_task: {
    icon: () => ListPlus,
    title: (i) => `Confie « ${str(i.title)} » à ${str(i.to)}`,
    kind: () => 'task',
  },
  update_task: {
    icon: () => ListChecks,
    title: (i) => `Tâche ${TASK_STATUSES[str(i.status)] ?? 'mise à jour'}`,
    kind: () => null,
  },
  list_tasks: { icon: () => ListChecks, title: () => 'Revoit ses tâches', kind: () => null },
  create_team: {
    icon: () => Users,
    title: (i) => `Crée l’équipe ${str(i.name)}`,
    kind: () => 'created',
  },
  create_bot: { icon: () => UserPlus, title: (i) => `Crée ${str(i.name)}`, kind: () => 'created' },
  update_bot: {
    icon: () => UserPen,
    title: (i) => `Met à jour ${str(i.bot)}`,
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

/** `2 recherches · 1 page · 5 captures` */
function summarize(tools: ToolPart[]): string {
  const counts = new Map<Kind, number>();
  for (const part of tools) {
    const kind = (TOOLS[part.toolName] ?? FALLBACK).kind(input(part));
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const words = [...counts].map(([kind, n]) => `${n} ${NOUNS[kind][n > 1 ? 1 : 0]}`);
  if (words.length === 0) return `${tools.length} action${tools.length > 1 ? 's' : ''}`;
  return words.join(' · ');
}

function Screenshot({ workspaceId, path }: { workspaceId: string; path: string }) {
  const image = useQuery({
    queryKey: ['file-blob', workspaceId, path],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const response = await client.fetch(
        `/api/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return URL.createObjectURL(await response.blob());
    },
  });
  useEffect(() => () => void (image.data && URL.revokeObjectURL(image.data)), [image.data]);
  if (!image.data)
    return <div className="aspect-[16/10] w-full animate-pulse rounded-lg bg-white/[0.04]" />;
  return (
    <img
      src={image.data}
      alt="Capture de l'écran du PC"
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

function ToolStep({ part }: { part: ToolPart }) {
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
  const [open, setOpen] = useState(false);
  const tools = parts.filter((p): p is ToolPart => p.type === 'tool');
  const steps = parts.filter((p) => p.type === 'tool' || p.text.trim());
  if (steps.length === 0 && !live) return null;

  const running = tools.findLast((p) => p.state === 'running');
  const errors = tools.filter((p) => p.state === 'error').length;
  const title = live
    ? running
      ? toolTitle(running)
      : 'Réfléchit…'
    : tools.length > 0
      ? summarize(tools)
      : 'Raisonnement';
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
            · {errors} échec{errors > 1 ? 's' : ''}
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
                  <ToolStep key={part.toolCallId} part={part} />
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
