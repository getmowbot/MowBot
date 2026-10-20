import type { Canvas, Notification } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUp, BellRing, Pause, Play } from 'lucide-react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { CanvasCard, SPAN } from '../components/canvas-card';
import { Button } from '../components/ui/button';
import { api } from '../lib/auth';
import { reveal } from '../lib/motion';
import {
  alertsPermission,
  useCanvases,
  useMarkNotificationsRead,
  useNotifications,
  useSystem,
  useUpdateSystem,
} from '../lib/proactivity';
import { useBots, useChef, useMe } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

const PRIORITY_DOT: Record<Notification['priority'], string> = {
  urgent: 'bg-destructive',
  normal: 'bg-primary',
  digest: 'bg-white/25',
};

function AskChef() {
  const { t } = useTranslation();
  const chef = useChef();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: async (value: string) => {
      await api.POST('/api/v1/bots/{id}/messages', {
        params: { path: { id: chef.data?.id as string } },
        body: { text: value },
      });
    },
    onSuccess: () => void navigate({ to: '/chef' }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (value && chef.data) send.mutate(value);
  };
  return (
    <form
      onSubmit={submit}
      className="glass flex items-center gap-2 rounded-2xl p-1.5 pl-2 transition-[border-color] duration-300 focus-within:border-white/30"
    >
      {chef.data && <BotAvatar seed={chef.data.avatarSeed} size={28} />}
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('home.askChef')}
        aria-label={t('home.askChef')}
        className="min-w-0 flex-1 bg-transparent px-1.5 py-2 text-[14.5px] outline-none placeholder:text-faint"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!text.trim() || send.isPending}
        aria-label={t('home.send')}
      >
        <ArrowUp className="size-4" />
      </Button>
    </form>
  );
}

function Notifications() {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const bots = useBots();
  const markRead = useMarkNotificationsRead();
  const [permission, setPermission] = useState(alertsPermission());
  const items = (notifications.data?.items ?? []).slice(0, 8);
  const unread = notifications.data?.unread ?? 0;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-medium">
          {t('home.notifications')}
          {unread > 0 && (
            <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
              {unread}
            </span>
          )}
        </h2>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => markRead.mutate(undefined)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('home.markAllRead')}
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-faint">{t('home.noNotifications')}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item) => {
            const bot = bots.data?.find((b) => b.id === item.botId);
            return (
              <li
                key={item.id}
                className={cn(
                  'flex gap-2.5 rounded-xl px-2 py-2 transition-colors',
                  !item.readAt && item.priority !== 'digest' && 'bg-white/[0.04]',
                )}
              >
                <span
                  className={cn(
                    'mt-1.5 size-1.5 shrink-0 rounded-full',
                    PRIORITY_DOT[item.priority],
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug">{item.title}</p>
                  {item.body && (
                    <p className="line-clamp-3 text-xs text-muted-foreground">{item.body}</p>
                  )}
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-faint">
                    {bot && <BotAvatar seed={bot.avatarSeed} size={12} />}
                    {bot?.name ?? 'MowBot'} · {timeAgo(item.createdAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {permission === 'default' && (
        <button
          type="button"
          onClick={() =>
            void window.Notification.requestPermission().then((value) => setPermission(value))
          }
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <BellRing className="size-3.5" /> {t('home.enableAlerts')}
        </button>
      )}
    </section>
  );
}

/** The home page: what the bots pinned (canvases), their news, and the kill switch. */
export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const bots = useBots();
  const canvases = useCanvases();
  const system = useSystem();
  const updateSystem = useUpdateSystem();
  const [showHidden, setShowHidden] = useState(false);

  const all = canvases.data ?? [];
  const hiddenCount = all.filter((c) => c.hidden).length;
  const shown = all.filter((c) => showHidden || !c.hidden);
  const working = (bots.data ?? []).filter(
    (b) => b.status === 'working' || b.status === 'waiting_bot',
  ).length;
  const paused = system.data?.paused ?? false;
  const evening = new Date().getHours() >= 18;
  const name = me.data?.owner.displayName ?? '';

  const reorder = useMutation({
    mutationFn: async (ids: string[]) => api.PUT('/api/v1/canvases/order', { body: { ids } }),
  });
  const move = (canvas: Canvas, direction: -1 | 1) => {
    const ids = all.map((c) => c.id);
    const index = ids.indexOf(canvas.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target] as string, ids[index] as string];
    reorder.mutate(ids);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <motion.header
        variants={reveal}
        initial="hidden"
        animate="shown"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {evening ? t('home.evening', { name }) : t('home.morning', { name })}
          </h1>
          <p className={cn('text-sm', working > 0 ? 'shimmer-text' : 'text-muted-foreground')}>
            {working > 0 ? t('home.working', { count: working }) : t('home.allIdle')}
          </p>
        </div>
        {!paused && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => confirm(t('home.confirmPause')) && updateSystem.mutate({ paused: true })}
          >
            <Pause className="size-3.5" /> {t('home.pause')}
          </Button>
        )}
      </motion.header>

      <AnimatePresence initial={false}>
        {paused && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/20 bg-white/[0.04] px-4 py-3">
              <Pause className="size-4 shrink-0" />
              <p className="min-w-0 flex-1 text-sm">{t('home.paused')}</p>
              <Button size="sm" onClick={() => updateSystem.mutate({ paused: false })}>
                <Play className="size-3.5" /> {t('home.resume')}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AskChef />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 space-y-3">
          {shown.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border-strong px-6 py-10 text-center">
              <p className="font-medium">{t('home.emptyTitle')}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {t('home.emptyBody')}
              </p>
            </div>
          ) : (
            <LayoutGroup>
              <div className="grid grid-flow-row-dense grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence initial={false}>
                  {shown.map((canvas, index) => (
                    <motion.div
                      key={canvas.id}
                      layout
                      initial={{ opacity: 0, scale: 0.98, filter: 'blur(6px)' }}
                      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, scale: 0.98, filter: 'blur(6px)' }}
                      className={SPAN[canvas.size]}
                    >
                      <CanvasCard
                        canvas={canvas}
                        bot={bots.data?.find((b) => b.id === canvas.botId)}
                        first={index === 0}
                        last={index === shown.length - 1}
                        onMove={(direction) => move(canvas, direction)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </LayoutGroup>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="text-xs text-faint transition-colors hover:text-foreground"
            >
              {t('home.hidden', { count: hiddenCount })} ·{' '}
              {showHidden ? t('home.hideHidden') : t('home.showHidden')}
            </button>
          )}
        </section>
        <aside className="min-w-0">
          <div className="glass rounded-2xl p-4 lg:sticky lg:top-0">
            <Notifications />
          </div>
        </aside>
      </div>
    </div>
  );
}
