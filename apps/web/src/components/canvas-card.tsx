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
  Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { i18n } from '../i18n';
import { api, problemMessage } from '../lib/auth';
import { cn, timeAgo } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { CanvasBody, type CardPress, type ChecklistActions } from './canvas-body';

/** Columns a card spans in the home grid (1 on phones, 2 on tablets, 3 on wide screens). */
export const SPAN: Record<CanvasSize, string> = {
  s: 'col-span-1',
  m: 'col-span-1 md:col-span-2',
  l: 'col-span-1 md:col-span-2 xl:col-span-3',
};

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
  if (content.kind === 'card') {
    return content.subtitle ? `${content.title} · ${content.subtitle}` : content.title;
  }
  if (content.kind === 'gallery') {
    return i18n.t('canvas.images', { count: content.images.length });
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

/** Ticks, adds and removes items of a checklist; the hub's event updates every device. */
function useChecklist(canvas: Canvas): ChecklistActions {
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
  return {
    toggle: (item) => toggle.mutate(item),
    add: (text) => add.mutate(text),
    remove: (itemId) => remove.mutate(itemId),
  };
}

/** A card's button that answers the bot: ticked a moment once sent (it can be pressed again). */
function useCardPress(canvas: Canvas) {
  const [sent, setSent] = useState<string | null>(null);
  const press = useMutation({
    mutationFn: async (button: number) => {
      const { error } = await api.POST('/api/v1/canvases/{id}/press', {
        params: { path: { id: canvas.id } },
        body: { button },
      });
      if (error) throw error;
    },
    onSuccess: (_, button) => {
      if (canvas.content.kind === 'card') setSent(canvas.content.buttons[button]?.label ?? null);
    },
  });
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(null), 2500);
    return () => clearTimeout(timer);
  }, [sent]);
  const state: CardPress = {
    onPress: (button) => press.mutate(button),
    chosen: sent,
    pending: press.isPending,
  };
  return { state, error: press.error };
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
  const checklist = useChecklist(canvas);
  const press = useCardPress(canvas);
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
          <CanvasBody
            content={content}
            title={canvas.title}
            workspaceId={workspaceId}
            version={canvas.updatedAt}
            size={canvas.size}
            checklist={checklist}
            press={press.state}
          />
          {press.error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {problemMessage(press.error, t('common.actionFailed'))}
            </p>
          )}
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
