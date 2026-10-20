import type { Bot, Team } from '@mowbot/contract';
import { Link } from '@tanstack/react-router';
import { Crown, Lock, UserPlus, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { BotAvatar, TeamAvatar } from '../components/bot-avatar';
import { StatusDot } from '../components/computer-status';
import { useOrgDialogs } from '../components/org-dialogs';
import { Button } from '../components/ui/button';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useChef, useComputers, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';

function BotLine({ bot, lead }: { bot: Bot; lead?: boolean }) {
  const { t } = useTranslation();
  const mood = moodOf(bot);
  return (
    <Link
      to={bot.isChef ? '/chef' : '/bots/$botId'}
      params={{ botId: bot.id }}
      className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.05]"
    >
      <BotAvatar seed={bot.avatarSeed} size={30} mood={mood} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{bot.name}</span>
          {lead && (
            <Crown
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={t('common.lead')}
            />
          )}
        </span>
        <span
          className={cn('block truncate text-xs', mood === 'idle' ? 'text-faint' : 'shimmer-text')}
        >
          {mood === 'idle' ? bot.role : statusLabel(bot, mood)}
        </span>
      </span>
    </Link>
  );
}

function TeamNode({ team, members }: { team: Team; members: Bot[] }) {
  const { t } = useTranslation();
  const computers = useComputers();
  const pc = computers.data?.find((c) => c.id === team.computerId);
  const sorted = [...members].sort(
    (a, b) => Number(b.id === team.leadBotId) - Number(a.id === team.leadBotId),
  );
  return (
    <motion.div
      variants={reveal}
      // The short stem joins the card to the rail above it.
      className="glass relative w-full space-y-2 rounded-2xl p-3 before:absolute before:-top-6 before:left-1/2 before:hidden before:h-6 before:w-px before:bg-border-strong sm:w-72 sm:before:block"
    >
      <Link
        to="/teams/$teamId"
        params={{ teamId: team.id }}
        className="flex items-center gap-2.5 rounded-xl px-1 py-1 transition-colors hover:bg-white/[0.04]"
      >
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={34} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{team.name}</span>
            {team.isolated && (
              <Lock className="size-3.5 text-muted-foreground" aria-label={t('common.isolated')} />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {team.mission ?? t('org.botCount', { count: members.length })}
          </span>
        </span>
        {pc && <StatusDot status={pc.status} />}
      </Link>
      <div className="space-y-0.5 border-t border-border pt-2">
        {sorted.length ? (
          sorted.map((bot) => <BotLine key={bot.id} bot={bot} lead={bot.id === team.leadBotId} />)
        ) : (
          <p className="px-2 py-1.5 text-xs text-faint">{t('common.noBots')}</p>
        )}
      </div>
    </motion.div>
  );
}

/** Org chart: the Chef, the teams under it with their bots, and the solo bots. */
export function OrgPage() {
  const { t } = useTranslation();
  const chef = useChef();
  const teams = useTeams();
  const bots = useBots();
  const dialogs = useOrgDialogs();
  const all = bots.data ?? [];
  const solo = all.filter((b) => !b.teamId);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shell.organization')}</h1>
          <p className="text-sm text-muted-foreground">{t('org.subtitle')}</p>
        </div>
        <Button variant="outline" onClick={() => dialogs.newTeam()}>
          <Users className="size-4" /> {t('common.newTeam')}
        </Button>
        <Button onClick={() => dialogs.newBot()}>
          <UserPlus className="size-4" /> {t('common.newBot')}
        </Button>
      </Reveal>

      {chef.data && (
        <div className="flex flex-col items-center">
          <Reveal>
            <Link to="/chef" className="flex flex-col items-center gap-2 rounded-2xl px-4 py-2">
              <BotAvatar
                seed={chef.data.avatarSeed}
                size={72}
                mood={moodOf(chef.data)}
                followPointer
              />
              <span className="font-semibold">{chef.data.name}</span>
            </Link>
          </Reveal>
          <div className="h-6 w-px bg-border-strong" />
          <motion.div
            initial="hidden"
            animate="shown"
            variants={stagger}
            // The rail the teams hang from, from the first card to the last (cards are w-72).
            className="relative flex w-full flex-wrap justify-center gap-4 pt-6 before:absolute before:left-36 before:right-36 before:top-0 before:hidden before:h-px before:bg-border-strong sm:w-fit sm:before:block"
          >
            {teams.data?.map((team) => (
              <TeamNode
                key={team.id}
                team={team}
                members={all.filter((b) => b.teamId === team.id)}
              />
            ))}
          </motion.div>
        </div>
      )}

      {solo.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium">{t('common.soloBots')}</h2>
          <motion.div
            initial="hidden"
            animate="shown"
            variants={stagger}
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {solo.map((bot) => (
              <motion.div key={bot.id} variants={reveal} className="glass rounded-2xl p-1.5">
                <BotLine bot={bot} />
              </motion.div>
            ))}
          </motion.div>
        </section>
      )}
    </div>
  );
}
