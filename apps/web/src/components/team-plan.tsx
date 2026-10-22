import type { Bot, PlanStep, PlanStepStatus, Team } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Eraser,
  FolderGit2,
  type LucideIcon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, problemMessage } from '../lib/auth';
import { useProjects } from '../lib/projects';
import { usePlan } from '../lib/queries';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Button } from './ui/button';
import { FormError } from './ui/form';

const STATUS: Record<PlanStepStatus, { icon: LucideIcon; className: string }> = {
  todo: { icon: Circle, className: 'text-faint' },
  doing: { icon: CircleDot, className: 'text-foreground' },
  done: { icon: CircleCheck, className: 'text-muted-foreground' },
  blocked: { icon: CircleAlert, className: 'text-warning' },
};

/** A step: where it stands, what it is, and who does it (opens their chat). */
function Step({ step, index, owner }: { step: PlanStep; index: number; owner: Bot | undefined }) {
  const { t } = useTranslation();
  const { icon: Icon, className } = STATUS[step.status];
  const label = t(`team.plan.status.${step.status}`);
  return (
    <li
      className={cn(
        '-mx-2 flex items-start gap-3 rounded-lg px-2 py-1.5',
        // Where the team is now stands out.
        step.status === 'doing' && 'bg-white/[0.05]',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', className)} aria-label={label} />
      <span className="w-4 shrink-0 pt-px text-right text-xs tabular-nums text-faint">
        {index + 1}
      </span>
      <span
        title={`${step.title} · ${label}`}
        className={cn(
          'line-clamp-2 min-w-0 flex-1 text-sm',
          step.status === 'done' && 'text-muted-foreground',
          step.status === 'doing' && 'font-medium',
        )}
      >
        {step.title}
      </span>
      {owner ? (
        <Link
          to={owner.isChef ? '/chef' : '/bots/$botId'}
          params={{ botId: owner.id }}
          title={owner.name}
          className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <BotAvatar seed={owner.avatarSeed} size={20} />
          <span className="hidden max-w-24 truncate sm:inline">{owner.name}</span>
        </Link>
      ) : (
        <span className="shrink-0 pt-px text-xs text-faint" title={t('team.plan.nobody')}>
          —
        </span>
      )}
    </li>
  );
}

/** The team's plan of attack: its goal, how far it got, and each step with who does it. */
export function TeamPlan({ team, bots }: { team: Team; bots: Bot[] }) {
  const { t } = useTranslation();
  const plan = usePlan(team.id);
  const projects = useProjects();
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
  const done = current?.steps.filter((step) => step.status === 'done').length ?? 0;
  const progress = t('team.plan.progress', { done, total });
  const project = current?.projectId
    ? projects.data?.find((p) => p.id === current.projectId)
    : undefined;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));

  return (
    <section className="space-y-3">
      <div className="flex min-h-9 items-center gap-2">
        <h2 className="font-medium">{t('team.plan.title')}</h2>
        {total > 0 && (
          <span className="text-sm tabular-nums text-faint" title={progress}>
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
        <div className="glass space-y-4 rounded-2xl p-4">
          <div className="space-y-1.5">
            <p className="text-sm leading-relaxed">{current.goal}</p>
            {project && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FolderGit2 className="size-3.5" />
                {t('team.plan.project', { name: project.name })}
              </p>
            )}
          </div>
          {total > 0 && (
            <>
              <div
                role="progressbar"
                aria-label={progress}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={done}
                className="h-1 overflow-hidden rounded-full bg-white/[0.06]"
              >
                <motion.div
                  className="h-full rounded-full bg-foreground/70"
                  initial={false}
                  animate={{ width: `${(done / total) * 100}%` }}
                  transition={springs.soft}
                />
              </div>
              <ol className="-my-1.5">
                {current.steps.map((step, index) => (
                  <Step
                    key={step.id}
                    step={step}
                    index={index}
                    owner={step.ownerBotId ? byId.get(step.ownerBotId) : undefined}
                  />
                ))}
              </ol>
            </>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('team.plan.empty')}</p>
      )}
      <FormError message={error} />
    </section>
  );
}
