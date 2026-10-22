import type { Bot, PlanStep, PlanStepStatus, Team, TeamPlan } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  ExternalLink,
  FileText,
  FolderGit2,
  type LucideIcon,
  Package,
  Target,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { isBusy, moodOf, statusLabel } from '../lib/bot-mood';
import { useProjects } from '../lib/projects';
import { useBots, usePlan, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { LiveDot } from './live-dot';

export const STEP_STATUS: Record<PlanStepStatus, { icon: LucideIcon; tone: string; bar: string }> =
  {
    todo: { icon: Circle, tone: 'text-faint', bar: 'bg-ink/[0.08]' },
    doing: { icon: CircleDot, tone: 'text-info', bar: 'bg-info' },
    done: { icon: CircleCheck, tone: 'text-success', bar: 'bg-success' },
    blocked: { icon: CircleAlert, tone: 'text-warning', bar: 'bg-warning' },
  };

/** How many steps stand where. */
export function tally(plan: TeamPlan): Record<PlanStepStatus, number> {
  const counts: Record<PlanStepStatus, number> = { todo: 0, doing: 0, done: 0, blocked: 0 };
  for (const step of plan.steps) counts[step.status]++;
  return counts;
}

/** The plan's progress in one bar: what is done, under way, blocked, then what is left. */
export function MissionProgress({ plan, className }: { plan: TeamPlan; className?: string }) {
  const { t } = useTranslation();
  const counts = tally(plan);
  const total = plan.steps.length;
  if (total === 0) return null;
  return (
    <div
      role="progressbar"
      aria-label={t('team.plan.progress', { done: counts.done, total })}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={counts.done}
      className={cn('flex h-1.5 gap-0.5 overflow-hidden rounded-full', className)}
    >
      {(['done', 'doing', 'blocked', 'todo'] as const).map((status) =>
        counts[status] ? (
          <motion.span
            key={status}
            layout
            transition={springs.soft}
            className={cn('h-full rounded-full', STEP_STATUS[status].bar)}
            style={{ flexGrow: counts[status] }}
          />
        ) : null,
      )}
    </div>
  );
}

/** Where a deliverable is: a page on the web, or a file of the team's workspace. */
export function DeliverableLink({ link, teamId }: { link: string; teamId: string }) {
  const { t } = useTranslation();
  const chip =
    'inline-flex max-w-full items-center gap-1 rounded-full border border-border-strong bg-ink/[0.03] px-2 py-0.5 text-[11px] text-muted-foreground transition-colors duration-200 hover:border-ink/25 hover:text-foreground';
  if (/^https?:\/\//i.test(link)) {
    let host = link;
    try {
      host = new URL(link).host;
    } catch {
      // Shown as it is.
    }
    return (
      <a href={link} target="_blank" rel="noreferrer" className={chip} title={link}>
        <ExternalLink className="size-3 shrink-0" />
        <span className="truncate">{host}</span>
      </a>
    );
  }
  return (
    <Link
      to="/teams/$teamId/files"
      params={{ teamId }}
      search={{ open: link }}
      className={chip}
      title={t('team.plan.openFile', { path: link })}
    >
      <FileText className="size-3 shrink-0" />
      <span className="truncate">{link.split('/').at(-1)}</span>
    </Link>
  );
}

function Owner({ bot, compact = false }: { bot: Bot | undefined; compact?: boolean }) {
  const { t } = useTranslation();
  if (!bot) {
    return (
      <span className="shrink-0 text-xs text-faint" title={t('team.plan.nobody')}>
        —
      </span>
    );
  }
  return (
    <Link
      to={bot.isChef ? '/chef' : '/bots/$botId'}
      params={{ botId: bot.id }}
      title={bot.name}
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <BotAvatar seed={bot.avatarSeed} size={compact ? 16 : 20} mood={moodOf(bot)} />
      {!compact && <span className="hidden max-w-24 truncate sm:inline">{bot.name}</span>}
    </Link>
  );
}

/** A step of the timeline: where it stands, what it delivers, and once done what it delivered. */
function TimelineStep({
  step,
  index,
  owner,
  teamId,
  last,
}: {
  step: PlanStep;
  index: number;
  owner: Bot | undefined;
  teamId: string;
  last: boolean;
}) {
  const { t } = useTranslation();
  const { icon: Icon, tone } = STEP_STATUS[step.status];
  const label = t(`team.plan.status.${step.status}`);
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!last && (
        <span
          aria-hidden
          className={cn(
            'absolute left-[9px] top-6 bottom-0 w-px',
            step.status === 'done' ? 'bg-success/40' : 'bg-border-strong',
          )}
        />
      )}
      <span className="relative mt-px grid size-5 shrink-0 place-items-center">
        {step.status === 'doing' && (
          <span className="absolute inset-0 animate-ping rounded-full bg-info/25" />
        )}
        <Icon className={cn('relative size-[18px]', tone)} aria-label={label} />
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 space-y-1',
          step.status === 'doing' && '-mx-2 -my-1 rounded-xl bg-info/[0.07] px-2 py-1',
        )}
      >
        <div className="flex items-start gap-2">
          <p
            title={`${index + 1}. ${step.title} · ${label}`}
            className={cn(
              'min-w-0 flex-1 text-sm leading-5',
              step.status === 'done' && 'text-muted-foreground',
              step.status === 'doing' && 'font-medium',
            )}
          >
            <span className="mr-1.5 text-xs tabular-nums text-faint">{index + 1}</span>
            {step.title}
          </p>
          <Owner bot={owner} />
        </div>
        {step.deliverable && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Package className="mt-px size-3.5 shrink-0 text-faint" />
            <span className="min-w-0">{step.deliverable}</span>
          </p>
        )}
        {(step.result || step.link) && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {step.result && <span className="min-w-0 text-foreground/80">{step.result}</span>}
            {step.link && <DeliverableLink link={step.link} teamId={teamId} />}
          </div>
        )}
      </div>
    </li>
  );
}

/** Who works on which step right now, with what they do this very moment. */
function RightNow({ steps, bots }: { steps: PlanStep[]; bots: Map<string, Bot> }) {
  const { t } = useTranslation();
  const doing = steps.filter((step) => step.status === 'doing');
  if (doing.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-faint">
        <LiveDot /> {t('team.plan.now')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {doing.map((step) => {
          const owner = step.ownerBotId ? bots.get(step.ownerBotId) : undefined;
          const live = owner && owner.status !== 'idle' ? statusLabel(owner) : null;
          return (
            <div
              key={step.id}
              className="flex items-center gap-3 rounded-xl border border-info/20 bg-info/[0.06] p-2.5"
            >
              {owner ? (
                <BotAvatar seed={owner.avatarSeed} size={32} mood={moodOf(owner)} />
              ) : (
                <CircleDot className="size-5 text-info" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={step.title}>
                  {step.title}
                </p>
                <p
                  className={cn(
                    'truncate text-xs text-muted-foreground',
                    owner && isBusy(owner) && 'shimmer-text',
                  )}
                  title={[owner?.name, owner?.focus, live].filter(Boolean).join(' · ')}
                >
                  {owner ? [owner.name, live ?? owner.focus].filter(Boolean).join(' · ') : '—'}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** What the mission delivered, then what it will deliver. */
function Deliverables({ plan }: { plan: TeamPlan }) {
  const { t } = useTranslation();
  const delivered = plan.steps.filter((s) => s.status === 'done' && (s.result || s.link));
  const coming = plan.steps.filter((s) => s.status !== 'done' && s.deliverable);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-sunken p-3">
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-faint">
        <Package className="size-3.5" /> {t('team.plan.deliverables')}
      </p>
      {delivered.length === 0 && coming.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('team.plan.noDeliverables')}</p>
      )}
      {delivered.length > 0 && (
        <ul className="space-y-2">
          {delivered.map((step) => (
            <li key={step.id} className="flex items-start gap-2 text-xs">
              <CircleCheck className="mt-px size-3.5 shrink-0 text-success" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-foreground/90">{step.deliverable ?? step.title}</p>
                {step.link && <DeliverableLink link={step.link} teamId={plan.teamId} />}
              </div>
            </li>
          ))}
        </ul>
      )}
      {coming.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-faint">{t('team.plan.coming')}</p>
          <ul className="space-y-1.5">
            {coming.map((step) => {
              const { icon: Icon, tone } = STEP_STATUS[step.status];
              return (
                <li key={step.id} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Icon className={cn('mt-px size-3.5 shrink-0', tone)} />
                  <span className="min-w-0">{step.deliverable}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "3 done · 1 under way · 1 blocked" */
function Counts({ plan }: { plan: TeamPlan }) {
  const { t } = useTranslation();
  const counts = tally(plan);
  const parts = (['done', 'doing', 'blocked'] as const).flatMap((status) =>
    counts[status]
      ? [{ status, text: t(`team.plan.counts.${status}`, { count: counts[status] }) }]
      : [],
  );
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {parts.map(({ status, text }) => (
        <span key={status} className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', STEP_STATUS[status].bar)} />
          {text}
        </span>
      ))}
      <span className="tabular-nums text-faint">
        {t('team.plan.progress', { done: counts.done, total: plan.steps.length })}
      </span>
    </p>
  );
}

/**
 * The team's mission as a dashboard: what it is after, how far it got, who works on what right
 * now, every step with what it delivers, and the deliverables, live.
 */
export function MissionBoard({ plan, bots }: { plan: TeamPlan; bots: Bot[] }) {
  const { t } = useTranslation();
  const projects = useProjects();
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const project = plan.projectId ? projects.data?.find((p) => p.id === plan.projectId) : undefined;
  return (
    <div className="glass space-y-5 rounded-2xl p-4 sm:p-5">
      <div className="space-y-2">
        <p className="text-[15px] font-medium leading-snug">{plan.goal}</p>
        {project && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FolderGit2 className="size-3.5" />
            {t('team.plan.project', { name: project.name })}
          </p>
        )}
      </div>
      {plan.steps.length > 0 && (
        <>
          <div className="space-y-2">
            <MissionProgress plan={plan} />
            <Counts plan={plan} />
          </div>
          <RightNow steps={plan.steps} bots={byId} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <ol>
              {plan.steps.map((step, index) => (
                <TimelineStep
                  key={step.id}
                  step={step}
                  index={index}
                  owner={step.ownerBotId ? byId.get(step.ownerBotId) : undefined}
                  teamId={plan.teamId}
                  last={index === plan.steps.length - 1}
                />
              ))}
            </ol>
            <Deliverables plan={plan} />
          </div>
        </>
      )}
    </div>
  );
}

/** Steps a plan card shows before "+ n more". */
const CARD_STEPS = 7;

/**
 * The plan as a bot shows it in the conversation (show_plan): the goal, the progress, the
 * steps with their owners, live; the whole mission a click away.
 */
export function PlanCard({
  teamId,
  optional = false,
  className,
}: {
  teamId: string;
  /** Nothing at all while the team has no plan (beside the PC), instead of saying so. */
  optional?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const plan = usePlan(teamId);
  const teams = useTeams();
  const bots = useBots();
  const team = teams.data?.find((candidate) => candidate.id === teamId);
  if (plan.isPending) {
    return optional ? null : (
      <div className={cn('glass h-28 animate-pulse rounded-2xl', className)} />
    );
  }
  const current = plan.data;
  if (!current || !team) {
    if (optional) return null;
    return <p className={cn('text-xs text-faint', className)}>{t('team.plan.gone')}</p>;
  }
  const byId = new Map((bots.data ?? []).map((bot) => [bot.id, bot]));
  const shown = current.steps.slice(0, CARD_STEPS);
  return (
    <div className={cn('glass max-w-md space-y-3 rounded-2xl p-4', className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Target className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {t('team.plan.missionOf', { name: team.name })}
        </span>
        <LiveDot />
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-snug">{current.goal}</p>
      <div className="space-y-1.5">
        <MissionProgress plan={current} />
        <Counts plan={current} />
      </div>
      {shown.length > 0 && (
        <ol className="space-y-1">
          {shown.map((step, index) => {
            const { icon: Icon, tone } = STEP_STATUS[step.status];
            return (
              <li
                key={step.id}
                className={cn(
                  '-mx-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px]',
                  step.status === 'doing' && 'bg-info/[0.07] font-medium',
                )}
              >
                <Icon className={cn('size-3.5 shrink-0', tone)} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate',
                    step.status === 'done' && 'text-muted-foreground',
                  )}
                  title={step.deliverable ? `${step.title} — ${step.deliverable}` : step.title}
                >
                  {index + 1}. {step.title}
                </span>
                {step.link && step.status === 'done' && (
                  <DeliverableLink link={step.link} teamId={teamId} />
                )}
                <Owner bot={step.ownerBotId ? byId.get(step.ownerBotId) : undefined} compact />
              </li>
            );
          })}
        </ol>
      )}
      {current.steps.length > shown.length && (
        <p className="text-xs text-faint">
          {t('team.plan.more', { count: current.steps.length - shown.length })}
        </p>
      )}
      <Link
        to="/teams/$teamId"
        params={{ teamId }}
        className="group inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {t('team.plan.openMission')}
        <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}

/**
 * Under a team bot's chat header: the mission in one line (goal, progress, the step under
 * way), opening the team's page. Nothing when the team has no plan.
 */
export function MissionBar({ team }: { team: Team }) {
  const { t } = useTranslation();
  const plan = usePlan(team.id);
  const bots = useBots();
  const current = plan.data;
  if (!current || current.steps.length === 0) return null;
  const counts = tally(current);
  const doing = current.steps.find((step) => step.status === 'doing');
  const owner = doing?.ownerBotId ? bots.data?.find((b) => b.id === doing.ownerBotId) : undefined;
  return (
    <Link
      to="/teams/$teamId"
      params={{ teamId: team.id }}
      className="group flex items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground transition-colors duration-200 hover:bg-ink/[0.03] hover:text-foreground md:px-6"
      title={current.goal}
    >
      <Target className="size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 max-w-[40%] truncate font-medium text-foreground/85">
        {current.goal}
      </span>
      <MissionProgress plan={current} className="hidden w-20 shrink-0 sm:flex" />
      <span className="shrink-0 tabular-nums">
        {counts.done}/{current.steps.length}
      </span>
      {doing && (
        <span className="hidden min-w-0 flex-1 truncate sm:block">
          <span className="text-faint">· </span>
          {t('team.plan.doingNow', { step: doing.title })}
          {owner && <span className="text-faint"> · {owner.name}</span>}
        </span>
      )}
      <ArrowRight className="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
    </Link>
  );
}
