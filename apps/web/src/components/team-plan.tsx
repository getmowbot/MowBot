import type { Bot, Team } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { Eraser } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, problemMessage } from '../lib/auth';
import { usePlan } from '../lib/queries';
import { MissionBoard, tally } from './mission';
import { Button } from './ui/button';
import { FormError } from './ui/form';

/** The team's mission: its plan of attack as a live dashboard, which the user can clear. */
export function TeamPlan({ team, bots }: { team: Team; bots: Bot[] }) {
  const { t } = useTranslation();
  const plan = usePlan(team.id);
  const [error, setError] = useState<string | null>(null);
  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/teams/{id}/plan', {
        params: { path: { id: team.id } },
      });
      if (error) throw error;
    },
    onError: (err) => setError(problemMessage(err, t('team.plan.notCleared'))),
  });

  if (plan.isPending) return null;
  const current = plan.data ?? null;
  const total = current?.steps.length ?? 0;
  const done = current ? tally(current).done : 0;

  return (
    <section className="space-y-3">
      <div className="flex min-h-9 items-center gap-2">
        <h2 className="font-medium">{t('team.plan.title')}</h2>
        {total > 0 && (
          <span
            className="text-sm tabular-nums text-faint"
            title={t('team.plan.progress', { done, total })}
          >
            {done}/{total}
          </span>
        )}
        {current && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            disabled={clear.isPending}
            title={t('team.plan.clear')}
            aria-label={t('team.plan.clear')}
            onClick={() => {
              setError(null);
              if (confirm(t('team.plan.confirmClear', { name: team.name }))) clear.mutate();
            }}
          >
            <Eraser className="size-4" />
          </Button>
        )}
      </div>
      {current ? (
        <MissionBoard plan={current} bots={bots} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('team.plan.empty')}</p>
      )}
      <FormError message={error} />
    </section>
  );
}
