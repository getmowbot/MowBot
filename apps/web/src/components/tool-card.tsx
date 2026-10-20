import type { MessagePart } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useQuery } from '@tanstack/react-query';
import {
  Camera,
  Check,
  ChevronDown,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  type LucideIcon,
  MousePointer2,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { client } from '../lib/auth';
import { cn } from '../lib/utils';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;
type Input = Record<string, unknown>;

const str = (value: unknown) => (typeof value === 'string' ? value : '');

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
      return `Défile ${str(input.direction) || 'vers le bas'}`;
    case 'drag':
      return `Glisse${at} → (${input.to_x}, ${input.to_y})`;
    default:
      return 'Action à l’écran';
  }
}

const TOOLS: Record<string, { icon: LucideIcon; label: (input: Input) => string; mono?: boolean }> =
  {
    bash: { icon: SquareTerminal, label: (i) => str(i.command), mono: true },
    read_file: { icon: FileText, label: (i) => `Lit ${str(i.path)}` },
    write_file: { icon: FilePen, label: (i) => `Écrit ${str(i.path)}` },
    list_files: { icon: FolderOpen, label: (i) => `Parcourt ${str(i.path) || '/workspace'}` },
    open_url: { icon: Globe, label: (i) => `Ouvre ${str(i.url)}` },
    screenshot: { icon: Camera, label: () => 'Regarde l’écran' },
    computer: { icon: MousePointer2, label: describeComputer },
  };

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

/** One action of the bot: what it did, live state, expandable result. */
export function ToolCard({ part }: { part: ToolPart }) {
  const meta = TOOLS[part.toolName] ?? { icon: Wrench, label: () => part.toolName };
  const Icon = meta.icon;
  const input = (part.input ?? {}) as Input;
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(part.output || part.image);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-white/[0.025] transition-colors duration-300',
        part.state === 'error' ? 'border-destructive/30' : 'border-border',
      )}
    >
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left disabled:cursor-default"
      >
        <span className="relative grid size-6 shrink-0 place-items-center">
          {part.state === 'running' && (
            <span className="absolute inset-0 animate-spin rounded-md [background:conic-gradient(from_0deg,transparent_0deg,var(--primary)_120deg,transparent_200deg)] [mask:linear-gradient(#000_0_0)_content-box_exclude,linear-gradient(#000_0_0)] p-px [animation-duration:1.1s]" />
          )}
          <span
            className={cn(
              'grid size-6 place-items-center rounded-md',
              part.state === 'error'
                ? 'bg-destructive/15 text-destructive'
                : 'bg-white/[0.06] text-muted-foreground',
            )}
          >
            <Icon className="size-3.5" />
          </span>
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px]',
            meta.mono && 'font-mono text-[12.5px]',
            part.state === 'running' ? 'shimmer-text' : 'text-foreground/85',
          )}
        >
          {meta.label(input) || part.toolName}
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          {part.state === 'done' && (
            <motion.span
              key="done"
              initial={{ opacity: 0, scale: 0.6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              transition={springs.snappy}
            >
              <Check className="size-3.5 text-primary" />
            </motion.span>
          )}
          {part.state === 'error' && (
            <motion.span key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <X className="size-3.5 text-destructive" />
            </motion.span>
          )}
        </AnimatePresence>
        {hasDetails && (
          <ChevronDown
            className={cn(
              'size-3.5 text-faint transition-transform duration-300',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasDetails && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
          >
            <div className="space-y-2 border-t border-border px-3 py-2.5">
              {part.image && (
                <Screenshot workspaceId={part.image.workspaceId} path={part.image.path} />
              )}
              {part.output && !part.image && (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted-foreground">
                  {part.output}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
