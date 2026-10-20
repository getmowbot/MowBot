import type { Bot, Canvas, CanvasContent, CanvasSize } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Ellipsis,
  Eye,
  EyeOff,
  type LucideIcon,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/auth';
import { cn, timeAgo } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Markdown } from './markdown';
import { WorkspaceImage } from './markdown-document';

/** Columns a card spans in the home grid (1 on phones, 2 on tablets, 3 on wide screens). */
export const SPAN: Record<CanvasSize, string> = {
  s: 'col-span-1',
  m: 'col-span-1 md:col-span-2',
  l: 'col-span-1 md:col-span-2 xl:col-span-3',
};

function Logo({
  workspaceId,
  path,
  name,
  version,
}: {
  workspaceId: string | null;
  path?: string;
  name: string;
  version: string;
}) {
  if (!path || !workspaceId) {
    return (
      <span className="grid size-12 place-items-center rounded-full bg-white/[0.06] text-lg font-semibold">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <WorkspaceImage
      workspaceId={workspaceId}
      path={path}
      alt={name}
      version={version}
      className="size-12 object-contain"
      placeholderClassName="size-12 aspect-auto rounded-full"
    />
  );
}

function Score({
  content,
  workspaceId,
  version,
}: {
  content: Extract<CanvasContent, { kind: 'score' }>;
  workspaceId: string | null;
  version: string;
}) {
  const played = content.homeScore !== null && content.awayScore !== null;
  const team = (side: 'home' | 'away') => {
    const value = content[side];
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center">
        <Logo workspaceId={workspaceId} path={value.logo} name={value.name} version={version} />
        <span className="max-w-full truncate text-sm font-medium">{value.name}</span>
      </div>
    );
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {team('home')}
        <div className="shrink-0 text-center">
          <p className="text-4xl font-semibold tabular-nums tracking-tight">
            {played ? `${content.homeScore} – ${content.awayScore}` : '–'}
          </p>
          <p className="mt-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground">
            {content.status}
          </p>
        </div>
        {team('away')}
      </div>
      {content.detail && <p className="text-center text-xs text-faint">{content.detail}</p>}
    </div>
  );
}

function Checklist({
  canvas,
  content,
}: {
  canvas: Canvas;
  content: Extract<CanvasContent, { kind: 'checklist' }>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const base = `/api/v1/canvases/{id}/items` as const;
  const toggle = useMutation({
    mutationFn: async (item: { id: string; done: boolean }) =>
      api.PATCH('/api/v1/canvases/{id}/items/{itemId}', {
        params: { path: { id: canvas.id, itemId: item.id } },
        body: { done: item.done },
      }),
  });
  const add = useMutation({
    mutationFn: async (value: string) =>
      api.POST(base, { params: { path: { id: canvas.id } }, body: { text: value } }),
  });
  const remove = useMutation({
    mutationFn: async (itemId: string) =>
      api.DELETE('/api/v1/canvases/{id}/items/{itemId}', {
        params: { path: { id: canvas.id, itemId } },
      }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    add.mutate(value);
    setText('');
  };
  return (
    <div className="space-y-1">
      {content.items.length === 0 && <p className="text-sm text-faint">{t('canvas.emptyList')}</p>}
      <ul className="space-y-0.5">
        {content.items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2.5 rounded-lg py-1">
            <button
              type="button"
              aria-pressed={item.done}
              aria-label={item.text}
              onClick={() => toggle.mutate({ id: item.id, done: !item.done })}
              className={cn(
                'grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors duration-200',
                item.done
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border-strong hover:border-white/40',
              )}
            >
              {item.done && <Check className="size-3" strokeWidth={3} />}
            </button>
            <span
              className={cn(
                'min-w-0 flex-1 text-sm transition-colors duration-200',
                item.done && 'text-faint line-through',
              )}
            >
              {item.text}
            </span>
            <button
              type="button"
              onClick={() => remove.mutate(item.id)}
              aria-label={t('canvas.removeItem', { text: item.text })}
              className="grid size-6 place-items-center rounded-md text-faint opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="flex items-center gap-2.5 pt-1">
        <Plus className="size-[18px] shrink-0 text-faint" />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('canvas.addItem')}
          maxLength={200}
          aria-label={t('canvas.addItem')}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </form>
    </div>
  );
}

function Stats({ content }: { content: Extract<CanvasContent, { kind: 'stats' }> }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-4 gap-y-3">
      {content.items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dd className="truncate text-2xl font-semibold tabular-nums tracking-tight">
            {item.value}
          </dd>
          <dt className="truncate text-xs text-muted-foreground">{item.label}</dt>
          {item.hint && <p className="truncate text-[11px] text-faint">{item.hint}</p>}
        </div>
      ))}
    </dl>
  );
}

const FRAME_HEIGHT: Record<CanvasSize, number> = { s: 200, m: 260, l: 360 };

/**
 * The bot's own page, in the strictest sandbox: no scripts, no network, nothing outside the
 * frame (a page written by a bot must not be able to show something else in its place).
 */
function HtmlFrame({ html, size }: { html: string; size: CanvasSize }) {
  const page = [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    '<style>:root{color-scheme:dark}html,body{margin:0;background:transparent;color:#e8e9ec;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}</style>',
    '</head><body>',
    // A refresh would navigate the frame elsewhere.
    html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, ''),
    '</body></html>',
  ].join('');
  return (
    <iframe
      title="canvas"
      sandbox=""
      srcDoc={page}
      style={{ height: FRAME_HEIGHT[size] }}
      className="w-full rounded-lg border-0"
    />
  );
}

const MENU_WIDTH = 224;

function MenuItem({
  icon: Icon,
  onClick,
  danger,
  active,
  children,
}: {
  icon?: LucideIcon;
  onClick(): void;
  danger?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
        danger ? 'text-destructive hover:bg-destructive/10' : 'hover:bg-white/[0.06]',
        active && 'text-foreground',
      )}
    >
      {Icon ? <Icon className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
      <span className="flex-1">{children}</span>
      {active && <Check className="size-3.5" />}
    </button>
  );
}

function CardMenu({
  canvas,
  bot,
  first,
  last,
  onMove,
}: {
  canvas: Canvas;
  bot: Bot | undefined;
  first: boolean;
  last: boolean;
  onMove(direction: -1 | 1): void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const update = useMutation({
    mutationFn: async (body: { size?: CanvasSize; hidden?: boolean }) =>
      api.PATCH('/api/v1/canvases/{id}', { params: { path: { id: canvas.id } }, body }),
  });
  const remove = useMutation({
    mutationFn: async () =>
      api.DELETE('/api/v1/canvases/{id}', { params: { path: { id: canvas.id } } }),
  });
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  /** Opens under the button, kept inside the window (cards clip and overlap each other). */
  const toggle = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) {
      setPlace({
        top: rect.bottom + 6,
        left: Math.min(Math.max(rect.right - MENU_WIDTH, 8), window.innerWidth - MENU_WIDTH - 8),
      });
    }
    setOpen((v) => !v);
  };
  const act = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={toggle}
        aria-label={t('canvas.menu', { title: canvas.title })}
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid size-7 place-items-center rounded-lg text-faint transition-colors hover:bg-white/[0.06] hover:text-foreground"
      >
        <Ellipsis className="size-4" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={menu}
              role="menu"
              style={{ top: place.top, left: place.left, width: MENU_WIDTH }}
              initial={{ opacity: 0, y: -6, scale: 0.97, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, scale: 0.97, filter: 'blur(4px)' }}
              transition={springs.snappy}
              className="glass fixed z-50 origin-top-right rounded-xl p-1"
            >
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-[0.12em] text-faint">
                {t('canvas.size')}
              </p>
              {(['s', 'm', 'l'] as const).map((size) => (
                <MenuItem
                  key={size}
                  active={canvas.size === size}
                  onClick={act(() => update.mutate({ size }))}
                >
                  {t(`canvas.sizes.${size}`)}
                </MenuItem>
              ))}
              <div className="my-1 border-t border-border" />
              {!first && (
                <MenuItem icon={ArrowLeft} onClick={act(() => onMove(-1))}>
                  {t('canvas.moveEarlier')}
                </MenuItem>
              )}
              {!last && (
                <MenuItem icon={ArrowRight} onClick={act(() => onMove(1))}>
                  {t('canvas.moveLater')}
                </MenuItem>
              )}
              <MenuItem
                icon={canvas.hidden ? Eye : EyeOff}
                onClick={act(() => update.mutate({ hidden: !canvas.hidden }))}
              >
                {canvas.hidden ? t('canvas.show') : t('canvas.hide')}
              </MenuItem>
              <MenuItem
                icon={Trash2}
                danger
                onClick={act(() => {
                  if (
                    confirm(
                      t('canvas.confirmDelete', { title: canvas.title, bot: bot?.name ?? '' }),
                    )
                  ) {
                    remove.mutate();
                  }
                })}
              >
                {t('canvas.delete')}
              </MenuItem>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/** One line that says the essentials of a folded card (a score, the first figure). */
function foldedSummary(content: CanvasContent): string | null {
  if (content.kind === 'score') {
    const score = (n: number | null) => (n === null ? '–' : String(n));
    return `${content.home.name} ${score(content.homeScore)}–${score(content.awayScore)} ${content.away.name}`;
  }
  if (content.kind === 'stats' && content.items[0]) {
    return `${content.items[0].label} : ${content.items[0].value}`;
  }
  return null;
}

/** Folds or unfolds a card at once; the hub's event confirms it on every device. */
function useFoldCanvas(canvas: Canvas) {
  const queryClient = useQueryClient();
  const setFolded = (collapsed: boolean) =>
    queryClient.setQueryData<Canvas[]>(['canvases'], (list) =>
      list?.map((c) => (c.id === canvas.id ? { ...c, collapsed } : c)),
    );
  return useMutation({
    mutationFn: async (collapsed: boolean) => {
      const { error } = await api.PATCH('/api/v1/canvases/{id}', {
        params: { path: { id: canvas.id } },
        body: { collapsed },
      });
      if (error) throw error;
    },
    onMutate: (collapsed) => setFolded(collapsed),
    onError: (_, collapsed) => setFolded(!collapsed),
  });
}

/** A bot's card on the home page. */
export function CanvasCard({
  canvas,
  bot,
  first,
  last,
  onMove,
}: {
  canvas: Canvas;
  bot: Bot | undefined;
  first: boolean;
  last: boolean;
  onMove(direction: -1 | 1): void;
}) {
  const { t } = useTranslation();
  const { content } = canvas;
  const workspaceId = bot?.workspaceId ?? null;
  const fold = useFoldCanvas(canvas);
  const folded = canvas.collapsed;
  const summary = folded ? foldedSummary(content) : null;
  return (
    <article
      className={cn(
        'glass flex flex-col gap-3 rounded-2xl p-4',
        !folded && 'h-full',
        canvas.hidden && 'opacity-50',
      )}
    >
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fold.mutate(!folded)}
          aria-expanded={!folded}
          title={folded ? t('canvas.unfold') : t('canvas.fold')}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-faint transition-transform duration-200',
              folded && '-rotate-90',
            )}
          />
          <h3 className="min-w-0 truncate font-medium">{canvas.title}</h3>
          {summary && (
            <span className="min-w-0 truncate text-sm text-muted-foreground">· {summary}</span>
          )}
        </button>
        {content.kind === 'checklist' && content.items.length > 0 && (
          <span className="text-xs tabular-nums text-faint">
            {content.items.filter((i) => i.done).length}/{content.items.length}
          </span>
        )}
        <CardMenu canvas={canvas} bot={bot} first={first} last={last} onMove={onMove} />
      </header>
      {!folded && (
        <div className="min-h-0 flex-1">
          {content.kind === 'score' && (
            <Score content={content} workspaceId={workspaceId} version={canvas.updatedAt} />
          )}
          {content.kind === 'checklist' && <Checklist canvas={canvas} content={content} />}
          {content.kind === 'stats' && <Stats content={content} />}
          {content.kind === 'note' && (
            <div className="space-y-3">
              {content.image && workspaceId && (
                <WorkspaceImage
                  workspaceId={workspaceId}
                  path={content.image}
                  alt={canvas.title}
                  version={canvas.updatedAt}
                  className="max-h-56 w-full rounded-lg object-cover"
                  placeholderClassName="h-40 aspect-auto"
                />
              )}
              <Markdown text={content.markdown} className="text-sm" />
            </div>
          )}
          {content.kind === 'html' && <HtmlFrame html={content.html} size={canvas.size} />}
        </div>
      )}
      <footer className="flex items-center gap-1.5 text-[11px] text-faint">
        {bot && <BotAvatar seed={bot.avatarSeed} size={14} />}
        <span className="truncate">
          {t('canvas.updated', { time: timeAgo(canvas.updatedAt), bot: bot?.name ?? '' })}
        </span>
      </footer>
    </article>
  );
}
