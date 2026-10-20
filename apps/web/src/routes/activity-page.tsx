import type { Bot, FeedItem, Task, TaskStatus } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, ListPlus } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { BotAvatar } from '../components/bot-avatar';
import { Markdown } from '../components/markdown';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label, Select, Textarea } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useFeed, useTasks } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: 'todo', title: 'À faire' },
  { status: 'doing', title: 'En cours' },
  { status: 'blocked', title: 'Bloquées' },
  { status: 'done', title: 'Terminées' },
];

const KIND_LABELS = {
  chat: 'message',
  ask: 'question',
  task: 'tâche',
  routine: 'routine',
} as const;

function Avatar({ bot, name, size = 22 }: { bot?: Bot; name: string; size?: number }) {
  return <BotAvatar seed={bot?.avatarSeed ?? name} size={size} title={name} />;
}

function TaskCard({ task, byId }: { task: Task; byId: Map<string, Bot> }) {
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
            {assignee?.name ?? 'Bot supprimé'} · de {creator?.name ?? 'toi'} ·{' '}
            {timeAgo(task.updatedAt)}
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
          Annuler la tâche
        </Button>
      )}
    </motion.div>
  );
}

function FeedRow({ item, byId }: { item: FeedItem; byId: Map<string, Bot> }) {
  const from = item.fromBotId ? byId.get(item.fromBotId) : undefined;
  const to = byId.get(item.toBotId);
  const text = item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  const fromName = from?.name ?? item.fromName ?? 'Bot supprimé';
  return (
    <motion.li variants={reveal} className="flex gap-3">
      <div className="flex shrink-0 items-center gap-1 pt-0.5">
        <Avatar bot={from} name={fromName} size={26} />
        <ArrowRight className="size-3 text-faint" />
        <Avatar bot={to} name={to?.name ?? '?'} size={26} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{fromName}</span> à{' '}
          {to ? (
            <Link
              to={to.isChef ? '/' : '/bots/$botId'}
              params={{ botId: to.id }}
              className="font-medium text-foreground hover:underline"
            >
              {to.name}
            </Link>
          ) : (
            'un bot supprimé'
          )}{' '}
          · {KIND_LABELS[item.kind]} · {timeAgo(item.createdAt)}
        </p>
        <Markdown text={text} className="mt-1 line-clamp-6 text-[13.5px] text-foreground/85" />
      </div>
    </motion.li>
  );
}

function NewTaskForm({ bots, onDone }: { bots: Bot[]; onDone(): void }) {
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
    onError: (err) => setError(problemMessage(err, 'Tâche non créée.')),
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
        <Label htmlFor="task-bot">Pour</Label>
        <Select id="task-bot" name="bot" required>
          {bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name} — {bot.role}
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-title">Tâche</Label>
        <Input id="task-title" name="title" required maxLength={200} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="task-details">Détails</Label>
        <Textarea
          id="task-details"
          name="details"
          rows={4}
          maxLength={8000}
          placeholder="Contexte, attentes, où livrer"
        />
      </div>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Envoi…' : 'Confier la tâche'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

/** What the bots do together: their tasks, and what they write to each other. */
export function ActivityPage() {
  const bots = useBots();
  const tasks = useTasks();
  const feed = useFeed();
  const [creating, setCreating] = useState(false);
  const byId = new Map((bots.data ?? []).map((b) => [b.id, b]));
  const exchanges = [...(feed.data ?? [])].reverse();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Activité</h1>
          <p className="text-sm text-muted-foreground">
            Les tâches que les bots se confient, et ce qu’ils se disent.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <ListPlus className="size-4" /> Nouvelle tâche
        </Button>
      </Reveal>

      <section className="space-y-3">
        <h2 className="font-medium">Tâches</h2>
        <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0">
          {COLUMNS.map((column) => {
            const items = (tasks.data ?? []).filter((t) =>
              column.status === 'done'
                ? t.status === 'done' || t.status === 'cancelled'
                : t.status === column.status,
            );
            return (
              <div key={column.status} className="w-64 shrink-0 snap-start space-y-2 md:w-auto">
                <p className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-[0.12em] text-faint">
                  {column.title}
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
        <h2 className="font-medium">Échanges entre bots</h2>
        {exchanges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Rien pour l’instant. Quand tes bots se parleront, tu verras tout ici.
          </p>
        ) : (
          <motion.ul initial="hidden" animate="shown" variants={stagger} className="space-y-4">
            {exchanges.map((item) => (
              <FeedRow key={item.id} item={item} byId={byId} />
            ))}
          </motion.ul>
        )}
      </section>

      <Dialog open={creating} onClose={() => setCreating(false)} title="Nouvelle tâche">
        <NewTaskForm bots={bots.data ?? []} onDone={() => setCreating(false)} />
      </Dialog>
    </div>
  );
}
