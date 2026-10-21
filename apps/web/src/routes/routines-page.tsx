import type { Bot, Routine, RoutineRunStatus, RoutineTrigger } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Copy, Play, Plus, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label, Select, Textarea } from '../components/ui/form';
import { Switch } from '../components/ui/switch';
import { api, apiBaseUrl, problemMessage } from '../lib/auth';
import { Reveal } from '../lib/motion';
import { useRoutineRuns, useRoutines } from '../lib/proactivity';
import { useBots } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

const STATUS_STYLE: Record<RoutineRunStatus, string> = {
  running: 'shimmer-text',
  done: 'text-foreground/80',
  idle: 'text-faint',
  error: 'text-destructive',
  skipped: 'text-muted-foreground',
};

function useTriggerLabel() {
  const { t } = useTranslation();
  return (trigger: RoutineTrigger) => {
    switch (trigger.type) {
      case 'cron':
        return t('routines.trigger.cron', { expr: trigger.expr });
      case 'interval':
        return t('routines.trigger.interval', { count: trigger.minutes });
      case 'once':
        return t('routines.trigger.once', {
          date: new Date(trigger.at).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        });
      case 'webhook':
        return t('routines.trigger.webhook');
    }
  };
}

function Runs({ routineId }: { routineId: string }) {
  const { t } = useTranslation();
  const runs = useRoutineRuns(routineId);
  if (!runs.data?.length) return <p className="text-xs text-faint">{t('routines.noRuns')}</p>;
  return (
    <ul className="space-y-1">
      {runs.data.map((run) => (
        <li key={run.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className={STATUS_STYLE[run.status]}>{t(`routines.status.${run.status}`)}</span>
          <span className="text-faint">{timeAgo(run.startedAt)}</span>
          {run.detail && <span className="text-muted-foreground">· {run.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function RoutineRow({ routine, bot }: { routine: Routine; bot?: Bot }) {
  const { t } = useTranslation();
  const label = useTriggerLabel();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const update = useMutation({
    mutationFn: async (enabled: boolean) =>
      api.PATCH('/api/v1/routines/{id}', {
        params: { path: { id: routine.id } },
        body: { enabled },
      }),
  });
  const run = useMutation({
    mutationFn: async () =>
      api.POST('/api/v1/routines/{id}/run', { params: { path: { id: routine.id } } }),
  });
  const remove = useMutation({
    mutationFn: async () =>
      api.DELETE('/api/v1/routines/{id}', { params: { path: { id: routine.id } } }),
  });
  const webhook = routine.webhookUrl
    ? `${apiBaseUrl || window.location.origin}${routine.webhookUrl}`
    : null;
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <Switch
          checked={routine.enabled}
          onChange={() => update.mutate(!routine.enabled)}
          label={t('routines.enabled', { name: routine.name })}
        />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{routine.name}</span>
            {!routine.silent && (
              <span className="shrink-0 rounded-full border border-border-strong px-1.5 text-[10px] text-muted-foreground">
                {t('routines.notifies')}
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {label(routine.trigger)}
            {routine.enabled &&
              routine.nextRunAt &&
              ` · ${t('routines.next', { time: timeAgo(routine.nextRunAt) })}`}
            {routine.lastStatus && (
              <span className={STATUS_STYLE[routine.lastStatus]}>
                {' · '}
                {t(`routines.status.${routine.lastStatus}`)}
              </span>
            )}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => run.mutate()}
          disabled={run.isPending}
          aria-label={t('routines.runNow', { name: routine.name })}
          title={t('routines.runNowShort')}
        >
          <Play className="size-4" />
        </Button>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-faint transition-transform duration-300',
            open && 'rotate-180',
          )}
        />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pl-12 pt-3">
              <p className="whitespace-pre-wrap text-sm text-foreground/85">{routine.prompt}</p>
              {webhook && (
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-black/40 px-2 py-1.5 font-mono text-xs">
                    {webhook}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard?.writeText(webhook).then(() => setCopied(true))
                    }
                  >
                    <Copy className="size-3.5" />{' '}
                    {copied ? t('routines.copied') : t('routines.copy')}
                  </Button>
                </div>
              )}
              <Runs routineId={routine.id} />
              <p className="text-xs text-faint">
                {t(`routines.createdBy.${routine.createdBy}`, { bot: bot?.name ?? '' })}
                {routine.failures > 0 &&
                  ` · ${t('routines.failures', { count: routine.failures })}`}
              </p>
              {routine.kind === 'custom' && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() =>
                    confirm(t('routines.confirmDelete', { name: routine.name })) && remove.mutate()
                  }
                >
                  <Trash2 className="size-3.5" /> {t('common.delete')}
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

type TriggerType = RoutineTrigger['type'];

function NewRoutineForm({ bots, onDone }: { bots: Bot[]; onDone(): void }) {
  const { t } = useTranslation();
  const [type, setType] = useState<TriggerType>('cron');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const value = (name: string) => String(form.get(name) ?? '').trim();
      const trigger: RoutineTrigger =
        type === 'cron'
          ? { type, expr: value('cron') }
          : type === 'interval'
            ? { type, minutes: Number(value('minutes')) }
            : type === 'once'
              ? { type, at: new Date(value('at')).toISOString() }
              : { type };
      const { error } = await api.POST('/api/v1/routines', {
        body: {
          botId: value('bot'),
          name: value('name'),
          prompt: value('prompt'),
          trigger,
          silent: form.get('notify') !== 'on',
        },
      });
      if (error) throw error;
    },
    onSuccess: onDone,
    onError: (err) => setError(problemMessage(err, t('routines.notCreated'))),
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="routine-bot">{t('routines.bot')}</Label>
          <Select id="routine-bot" name="bot" required>
            {bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="routine-name">{t('common.name')}</Label>
          <Input
            id="routine-name"
            name="name"
            required
            maxLength={100}
            placeholder={t('routines.namePlaceholder')}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="routine-prompt">{t('routines.instruction')}</Label>
        <Textarea
          id="routine-prompt"
          name="prompt"
          required
          rows={3}
          maxLength={4000}
          placeholder={t('routines.instructionPlaceholder')}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="routine-type">{t('routines.when')}</Label>
          <Select
            id="routine-type"
            value={type}
            onChange={(event) => setType(event.target.value as TriggerType)}
          >
            {(['cron', 'interval', 'once', 'webhook'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`routines.types.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          {type === 'cron' && (
            <>
              <Label htmlFor="routine-cron">{t('routines.cron')}</Label>
              <Input
                id="routine-cron"
                name="cron"
                required
                defaultValue="0 8 * * *"
                className="font-mono"
              />
            </>
          )}
          {type === 'interval' && (
            <>
              <Label htmlFor="routine-minutes">{t('routines.minutes')}</Label>
              <Input
                id="routine-minutes"
                name="minutes"
                type="number"
                min={5}
                required
                defaultValue={60}
              />
            </>
          )}
          {type === 'once' && (
            <>
              <Label htmlFor="routine-at">{t('routines.at')}</Label>
              <Input id="routine-at" name="at" type="datetime-local" required />
            </>
          )}
          {type === 'webhook' && (
            <p className="pt-6 text-xs text-muted-foreground">{t('routines.webhookHint')}</p>
          )}
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm">
        <input type="checkbox" name="notify" className="size-4 accent-white" />
        {t('routines.notify')}
      </label>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t('common.creating') : t('routines.create')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Every routine and check-in, by bot: what fires when, how it went, switches and history. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const routines = useRoutines();
  const bots = useBots();
  const [creating, setCreating] = useState(false);
  const all = routines.data ?? [];
  const groups = (bots.data ?? [])
    .map((bot) => ({ bot, items: all.filter((r) => r.botId === bot.id) }))
    .filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('routines.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('routines.subtitle')}</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" /> {t('routines.new')}
        </Button>
      </Reveal>

      {routines.isSuccess && groups.length === 0 && (
        <p className="rounded-2xl border border-dashed border-border-strong px-6 py-10 text-center text-sm text-muted-foreground">
          {t('routines.empty')}
        </p>
      )}

      {groups.map(({ bot, items }) => (
        <Reveal key={bot.id} className="glass rounded-2xl px-4 py-2">
          <p className="flex items-center gap-2 pt-2 text-sm font-medium">
            <BotAvatar seed={bot.avatarSeed} size={22} /> {bot.name}
          </p>
          <ul className="divide-y divide-border">
            {items.map((routine) => (
              <RoutineRow key={routine.id} routine={routine} bot={bot} />
            ))}
          </ul>
        </Reveal>
      ))}

      <Dialog open={creating} onClose={() => setCreating(false)} title={t('routines.new')}>
        <NewRoutineForm bots={bots.data ?? []} onDone={() => setCreating(false)} />
      </Dialog>
    </div>
  );
}
