import type { ComputerGpus, ComputerSystem, Gpu } from '@mowbot/contract';
import { Check, Cpu, type LucideIcon, Monitor, RotateCw, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { useComputer, useComputerAction, useConfigureComputer, useGpus } from '../lib/queries';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, FormError } from './ui/form';

const SYSTEMS: { value: ComputerSystem; icon: LucideIcon }[] = [
  { value: 'desktop', icon: Monitor },
  { value: 'terminal', icon: SquareTerminal },
];

/** With its desktop or only a shell: two cards, one picked. */
export function SystemChoice({
  value,
  onChange,
  disabled,
}: {
  value: ComputerSystem;
  onChange(system: ComputerSystem): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <fieldset aria-label={t('computer.setup.system')} className="grid gap-2 sm:grid-cols-2">
      {SYSTEMS.map(({ value: system, icon: Icon }) => {
        const on = system === value;
        return (
          <button
            key={system}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(system)}
            className={cn(
              'relative flex items-start gap-3 rounded-2xl border p-3 text-left transition-[background-color,border-color] duration-200 disabled:opacity-50',
              on
                ? 'border-ink/30 bg-ink/[0.06]'
                : 'border-border-strong bg-ink/[0.02] hover:border-ink/20 hover:bg-ink/[0.04]',
            )}
          >
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-xl',
                on ? 'pebble' : 'bg-ink/[0.05] text-muted-foreground',
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t(`computer.setup.${system}`)}</span>
              <span className="block text-xs text-muted-foreground">
                {t(`computer.setup.${system}Hint`)}
              </span>
            </span>
            {on && <Check className="size-4 shrink-0 text-foreground" />}
          </button>
        );
      })}
    </fieldset>
  );
}

const gb = (gpu: Gpu) => (gpu.memoryMb ? Math.round(gpu.memoryMb / 1024) : null);

/** The host's cards a PC gets: all of them, some, or none. */
export function GpuChoice({
  value,
  onChange,
  disabled,
}: {
  value: ComputerGpus | null;
  onChange(gpus: ComputerGpus | null): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const gpus = useGpus();
  if (gpus.isPending) return null;
  const host = gpus.data;
  if (!host?.available) {
    return <p className="text-xs text-muted-foreground">{t('computer.setup.noGpu')}</p>;
  }
  const picked = (gpu: Gpu) => value === 'all' || (Array.isArray(value) && value.includes(gpu.id));
  const toggle = (gpu: Gpu) => {
    const current = value === 'all' ? host.items.map((g) => g.id) : (value ?? []);
    const next = current.includes(gpu.id)
      ? current.filter((id) => id !== gpu.id)
      : [...current, gpu.id];
    onChange(next.length === 0 ? null : next.length === host.items.length ? 'all' : next);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {host.items.map((gpu) => {
          const on = picked(gpu);
          const size = gb(gpu);
          return (
            <button
              key={gpu.id}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => toggle(gpu)}
              title={gpu.id}
              className={cn(
                'inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm transition-[background-color,border-color] duration-200 disabled:opacity-50',
                on
                  ? 'border-ink/30 bg-ink/[0.07] text-foreground'
                  : 'border-border-strong text-muted-foreground hover:border-ink/20 hover:text-foreground',
              )}
            >
              <Cpu className="size-3.5" />
              <span className="max-w-64 truncate">{gpu.name}</span>
              {size && (
                <span className="text-xs text-faint">{t('computer.setup.memory', { size })}</span>
              )}
              {on && <Check className="size-3.5" />}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('computer.setup.gpusHint')}</p>
    </div>
  );
}

/**
 * The team's computer: what it runs and the cards it gets, saved as they change. A running PC
 * takes them once restarted.
 */
export function ComputerSetup({ computerId }: { computerId: string }) {
  const { t } = useTranslation();
  const computer = useComputer(computerId);
  const configure = useConfigureComputer(computerId);
  const action = useComputerAction(computerId);
  const pc = computer.data;
  if (!pc) return null;
  return (
    <Card className="space-y-4">
      <h2 className="font-medium">{t('computer.setup.title')}</h2>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('computer.setup.system')}</p>
        <SystemChoice
          value={pc.system}
          disabled={configure.isPending}
          onChange={(system) => system !== pc.system && configure.mutate({ system })}
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('computer.setup.gpus')}</p>
        <GpuChoice
          value={pc.gpus}
          disabled={configure.isPending}
          onChange={(gpus) => configure.mutate({ gpus })}
        />
      </div>
      {pc.restartNeeded && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-info/25 bg-info/[0.07] px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{t('computer.setup.restartNeeded')}</span>
          <Button size="sm" disabled={action.isPending} onClick={() => action.mutate('restart')}>
            <RotateCw className="size-3.5" /> {t('computer.setup.restartNow')}
          </Button>
        </div>
      )}
      <FormError
        message={
          configure.isError ? problemMessage(configure.error, t('computer.setup.notSaved')) : null
        }
      />
    </Card>
  );
}
