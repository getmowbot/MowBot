import type { Bot, BotUpdate, ModelRef, Provider, WatchLevel } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { ViewSwitch } from '../components/bot-browser-view';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { Reveal } from '../lib/motion';
import { useSystem, useUpdateSystem } from '../lib/proactivity';
import { useBots, useProviders } from '../lib/queries';

const HEARTBEATS = [null, 15, 30, 60, 120, 240, 720] as const;
const WATCH_LEVELS: WatchLevel[] = ['off', 'light', 'active'];

function GlobalSettings() {
  const { t } = useTranslation();
  const system = useSystem();
  const update = useUpdateSystem();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const settings = system.data;
  if (!settings) return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const budget = String(form.get('budget') ?? '').trim();
    setError(null);
    update.mutate(
      {
        quietHours:
          form.get('quiet') === 'on'
            ? { start: String(form.get('start')), end: String(form.get('end')) }
            : null,
        dailyTokenBudget: budget ? Number(budget) : null,
      },
      {
        onSuccess: () => setSaved(true),
        onError: (err) => setError(problemMessage(err, t('common.settingsNotSaved'))),
      },
    );
  };
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{t('proactivity.pause')}</h2>
          <p className="text-sm text-muted-foreground">{t('proactivity.pauseHint')}</p>
        </div>
        <Button
          variant={settings.paused ? 'default' : 'outline'}
          onClick={() => update.mutate({ paused: !settings.paused })}
        >
          {settings.paused ? t('home.resume') : t('home.pause')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{t('proactivity.watch')}</h2>
          <p className="text-sm text-muted-foreground">
            {t(`proactivity.watchHints.${settings.watch}`)}
          </p>
        </div>
        <ViewSwitch
          value={settings.watch}
          options={WATCH_LEVELS.map((level) => ({
            value: level,
            label: t(`proactivity.watchLevels.${level}`),
          }))}
          onChange={(watch) => update.mutate({ watch })}
        />
      </div>
      <form
        className="space-y-4 border-t border-border pt-4"
        onChange={() => setSaved(false)}
        onSubmit={submit}
      >
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            name="quiet"
            defaultChecked={Boolean(settings.quietHours)}
            className="size-4 accent-[var(--primary)]"
          />
          {t('proactivity.quietHours')}
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Input
            name="start"
            type="time"
            defaultValue={settings.quietHours?.start ?? '22:00'}
            className="w-28"
            aria-label={t('proactivity.quietStart')}
          />
          {t('proactivity.to')}
          <Input
            name="end"
            type="time"
            defaultValue={settings.quietHours?.end ?? '07:00'}
            className="w-28"
            aria-label={t('proactivity.quietEnd')}
          />
          <span className="text-xs text-faint">({settings.timeZone})</span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="global-budget">{t('proactivity.globalBudget')}</Label>
          <Input
            id="global-budget"
            name="budget"
            type="number"
            min={1000}
            step={1000}
            defaultValue={settings.dailyTokenBudget ?? ''}
            placeholder={t('proactivity.noLimit')}
            className="max-w-48"
          />
          <p className="text-xs text-faint">{t('proactivity.budgetHint')}</p>
        </div>
        <FormError message={error} />
        <Button type="submit" disabled={update.isPending}>
          {saved ? t('common.saved') : t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

/** Provider + model, or nothing. */
function ModelPicker({
  name,
  label,
  value,
  providers,
}: {
  name: string;
  label: string;
  value: ModelRef | null | undefined;
  providers: Provider[];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${name}-provider`}>{label}</Label>
      <div className="flex gap-2">
        <Select
          id={`${name}-provider`}
          name={`${name}-provider`}
          defaultValue={value?.providerId ?? ''}
          className="w-auto min-w-36"
        >
          <option value="">{t('proactivity.none')}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </Select>
        <Input
          name={`${name}-model`}
          defaultValue={value?.model ?? ''}
          placeholder={t('proactivity.modelPlaceholder')}
          aria-label={t('proactivity.modelOf', { label })}
          className="min-w-0 flex-1"
        />
      </div>
    </div>
  );
}

function BotProactivity({ bot, providers }: { bot: Bot; providers: Provider[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (body: BotUpdate) => {
      const { error } = await api.PATCH('/api/v1/bots/{id}', {
        params: { path: { id: bot.id } },
        body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['routines'] });
    },
    onError: (err) => setError(problemMessage(err, t('common.settingsNotSaved'))),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const ref = (prefix: string): ModelRef | null => {
      const providerId = String(form.get(`${prefix}-provider`) ?? '');
      const model = String(form.get(`${prefix}-model`) ?? '').trim();
      return providerId && model ? { providerId, model } : null;
    };
    const heartbeat = String(form.get('heartbeat') ?? '');
    const budget = String(form.get('budget') ?? '').trim();
    const fallback = ref('fallback');
    setError(null);
    save.mutate({
      heartbeatMinutes: heartbeat ? Number(heartbeat) : null,
      dailyTokenBudget: budget ? Number(budget) : null,
      lightModel: ref('light'),
      fallbacks: fallback ? [fallback] : [],
    });
  };
  return (
    <Card className="space-y-4">
      <p className="flex items-center gap-2.5 font-medium">
        <BotAvatar seed={bot.avatarSeed} size={28} /> {bot.name}
      </p>
      <form className="space-y-4" onChange={() => setSaved(false)} onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`heartbeat-${bot.id}`}>{t('proactivity.heartbeat')}</Label>
            <Select
              id={`heartbeat-${bot.id}`}
              name="heartbeat"
              defaultValue={bot.heartbeatMinutes ?? ''}
            >
              {HEARTBEATS.map((minutes) => (
                <option key={minutes ?? 'off'} value={minutes ?? ''}>
                  {minutes === null
                    ? t('proactivity.heartbeatOff')
                    : minutes < 60
                      ? t('proactivity.everyMinutes', { count: minutes })
                      : t('proactivity.everyHours', { count: minutes / 60 })}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`budget-${bot.id}`}>{t('proactivity.botBudget')}</Label>
            <Input
              id={`budget-${bot.id}`}
              name="budget"
              type="number"
              min={1000}
              step={1000}
              defaultValue={bot.dailyTokenBudget ?? ''}
              placeholder={t('proactivity.noLimit')}
            />
          </div>
        </div>
        <ModelPicker
          name="light"
          label={t('proactivity.lightModel')}
          value={bot.lightModel}
          providers={providers}
        />
        <ModelPicker
          name="fallback"
          label={t('proactivity.fallback')}
          value={bot.fallbacks[0]}
          providers={providers}
        />
        <FormError message={error} />
        <Button type="submit" disabled={save.isPending}>
          {saved ? t('common.saved') : t('common.save')}
        </Button>
      </form>
    </Card>
  );
}

/** How much bots act on their own: the kill switch, quiet hours, budgets, check-ins, models. */
export function ProactivityPage() {
  const { t } = useTranslation();
  const bots = useBots();
  const providers = useProviders();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">{t('proactivity.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('proactivity.subtitle')}</p>
      </Reveal>
      <Reveal delay={0.04}>
        <GlobalSettings />
      </Reveal>
      {bots.data?.map((bot) => (
        <Reveal key={bot.id} delay={0.08}>
          <BotProactivity bot={bot} providers={providers.data ?? []} />
        </Reveal>
      ))}
    </div>
  );
}
