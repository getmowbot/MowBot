import type { Bot, FeedItem, Task } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Eraser, ListPlus } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { Markdown } from '../components/markdown';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label, Select, Textarea } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useFeed, useTasks } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

/** Kanban columns; cancelled tasks go with the done ones. */
const COLUMNS = ['todo', 'doing', 'blocked', 'done'] as const;

function Avatar({ bot, name, size = 22 }: { bot?: Bot; name: string; size?: number }) {
  return <BotAvatar seed={bot?.avatarSeed ?? name} size={size} title={name} />;
}

function TaskCard({ task, byId }: { task: Task; byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const assignee = byId.get(task.assigneeBotId);
  const creator = task.creatorBotId ? byId.get(task.creatorBotId) : undefined;
  const cancel = useMutation({
    mutationFn: async () => {
      await api.PATCH('/api/v1/tasks/{id}', {
        params: { path: { id: task.id } },
        body: { status: 'cancelled' },
      });
    },
  });
  const finished = task.status === 'done' || task.status === 'cancelled';
  return (
    <motion.div layout="position" variants={reveal} className="glass space-y-2 rounded-xl p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full text-left">
        <p
          className={cn(
            'text-sm font-medium',
            task.status === 'cancelled' && 'line-through opacity-60',
          )}
        >
          {task.title}
        </p>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {assignee && <Avatar bot={assignee} name={assignee.name} size={18} />}
          <span className="truncate">
            {t('activityPage.taskMeta', {
              assignee: assignee?.name ?? t('activityPage.deletedBot'),
              creator: creator?.name ?? t('activityPage.you'),
              time: timeAgo(task.updatedAt),
            })}
          </span>
        </p>
      </button>
      {(open || task.result) && (
        <div className={cn('text-xs text-muted-foreground', !open && 'line-clamp-3')}>
          {open && task.details && <p className="mb-2 whitespace-pre-wrap">{task.details}</p>}
          {task.result && <p className="whitespace-pre-wrap text-foreground/80">{task.result}</p>}
        </div>
      )}
      {open && !finished && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
        >
          {t('activityPage.cancelTask')}
        </Button>
      )}
    </motion.div>
  );
}

function FeedRow({ item, byId }: { item: FeedItem; byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  const from = item.fromBotId ? byId.get(item.fromBotId) : undefined;
  const to = byId.get(item.toBotId);
  const text = item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const fromName = from?.name ?? item.fromName ?? t('activityPage.deletedBot');
  return (
    <motion.li variants={reveal} className="flex gap-3">
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        <Avatar bot={from} name={fromName} size={26} />
        <ArrowRight className="size-3 text-faint" />
        <Avatar bot={to} name={to?.name ?? '?'} size={26} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{fromName}</span> {t('activityPage.feedTo')}{' '}
          {to ? (
            <Link
              to={to.isChef ? '/chef' : '/bots/$botId'}
              params={{ botId: to.id }}
              className="font-medium text-foreground hover:underline"
            >
              {to.name}
            </Link>
          ) : (
            t('activityPage.aDeletedBot')
          )}{' '}
          · {t(`common.kinds.${item.kind}`)} · {timeAgo(item.createdAt)}
        </p>
        <Markdown text={text} className="mt-1 line-clamp-6 text-[13.5px] text-foreground/85" />
      </div>
    </motion.li>
  );
}

function NewTaskForm({ bots, onDone }: { bots: Bot[]; onDone(): void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const details = String(form.get('details') ?? '').trim();
      const { error } = await api.POST('/api/v1/tasks', {
        body: {
          assigneeBotId: String(form.get('bot')),
          title: String(form.get('title')).trim(),
          details: details || undefined,
        },
      });
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (err) => setError(problemMessage(err, t('activityPage.taskNotCreated'))),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        create.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="task-bot">{t('activityPage.assignee')}</Label>
        <Select id="task-bot" name="bot" required>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name} — {bot.role}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-title">{t('activityPage.task')}</Label>
        <Input id="task-title" name="title" required maxLength={200} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-details">{t('activityPage.details')}</Label>
        <Textarea
          id="task-details"
          name="details"
          rows={4}
          maxLength={8000}
          placeholder={t('activityPage.detailsPlaceholder')}
        />
      </div>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('common.sending') : t('activityPage.assign')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** What the bots do together: their tasks, and what they write to each other. */
export function ActivityPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const bots = useBots();
  const tasks = useTasks();
  const feed = useFeed();
  const [creating, setCreating] = useState(false);
  const byId = new Map((bots.data ?? []).map((b) => [b.id, b]));
  const exchanges = [...(feed.data ?? [])].reverse();
  const clearable =
    exchanges.length > 0 ||
    (tasks.data ?? []).some((task) => task.status === 'done' || task.status === 'cancelled');
  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/activity/clear');
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
    },
    onError: (err) => alert(problemMessage(err, t('activityPage.notCleared'))),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('activityPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('activityPage.subtitle')}</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => confirm(t('activityPage.confirmClear')) && clear.mutate()}
          disabled={!clearable || clear.isPending}
        >
          <Eraser className="size-4" /> {t('activityPage.clear')}
        </Button>
        <Button onClick={() => setCreating(true)}>
          <ListPlus className="size-4" /> {t('activityPage.newTask')}
        </Button>
      </Reveal>

      <section className="space-y-3">
        <h2 className="font-medium">{t('activityPage.tasks')}</h2>
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0">
          {COLUMNS.map((column) => {
            const items = (tasks.data ?? []).filter((task) =>
              column === 'done'
                ? task.status === 'done' || task.status === 'cancelled'
                : task.status === column,
            );
            return (
              <div key={column} className="w-64 shrink-0 snap-start space-y-2 md:w-auto">
                <p className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-[0.12em] text-faint">
                  {t(`activityPage.columns.${column}`)}
                  <span className="tabular-nums">{items.length}</span>
                </p>
                <motion.div
                  initial="hidden"
                  animate="shown"
                  variants={stagger}
                  className="space-y-2"
                >
                  {items.map((task) => (
                    <TaskCard key={task.id} task={task} byId={byId} />
                  ))}
                </motion.div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('activityPage.exchanges')}</h2>
        {exchanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('activityPage.empty')}</p>
        ) : (
          <motion.ul initial="hidden" animate="shown" variants={stagger} className="space-y-4">
            {exchanges.map((item) => (
              <FeedRow key={item.id} item={item} byId={byId} />
            ))}
          </motion.ul>
        )}
      </section>

      <Dialog open={creating} onClose={() => setCreating(false)} title={t('activityPage.newTask')}>
        <NewTaskForm bots={bots.data ?? []} onDone={() => setCreating(false)} />
      </Dialog>
    </div>
  );
}
