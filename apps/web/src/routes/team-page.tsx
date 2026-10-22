import type { Bot, Team } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Crown,
  Eraser,
  FolderOpen,
  Lock,
  Monitor,
  Settings2,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar, TeamAvatar } from '../components/bot-avatar';
import { StatusBadge } from '../components/computer-status';
import { useOrgDialogs } from '../components/org-dialogs';
import { TeamPlan } from '../components/team-plan';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select, Textarea } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { isBusy, moodOf, statusLabel } from '../lib/bot-mood';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useComputers, useTeam } from '../lib/queries';
import { cn } from '../lib/utils';

/** A member: what it works on (its role when it says nothing), and what it does right now. */
function MemberCard({ bot, lead }: { bot: Bot; lead: boolean }) {
  const { t } = useTranslation();
  const dialogs = useOrgDialogs();
  const mood = moodOf(bot);
  const status = bot.status === 'idle' ? null : statusLabel(bot);
  return (
    <motion.div variants={reveal} className="glass flex items-center gap-3 rounded-2xl p-3">
      <Link
        to={bot.isChef ? '/chef' : '/bots/$botId'}
        params={{ botId: bot.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{bot.name}</span>
            {lead && (
              <Crown
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={t('common.lead')}
              />
            )}
          </span>
          {bot.focus ? (
            <span title={`${bot.focus} — ${bot.role}`} className="block truncate text-sm">
              {bot.focus}
            </span>
          ) : (
            <span title={bot.role} className="block truncate text-xs text-muted-foreground">
              {bot.role}
            </span>
          )}
          {status && (
            <span
              title={status}
              className={cn(
                'block truncate text-xs',
                isBusy(bot)
                  ? 'shimmer-text'
                  : bot.status === 'error'
                    ? 'text-destructive/80'
                    : 'text-faint',
              )}
            >
              {status}
            </span>
          )}
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => dialogs.botSettings(bot)}
        aria-label={t('common.settingsOf', { name: bot.name })}
      >
        <Settings2 className="size-4" />
      </Button>
    </motion.div>
  );
}

function TeamSettings({ team, members }: { team: Team; members: Bot[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isolated, setIsolated] = useState(team.isolated);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const lead = String(form.get('lead') ?? '');
      const { error } = await api.PATCH('/api/v1/teams/{id}', {
        params: { path: { id: team.id } },
        body: {
          name: String(form.get('name')).trim(),
          mission: String(form.get('mission') ?? '').trim() || null,
          isolated,
          leadBotId: lead || null,
        },
      });
      if (error) throw error;
    },
    onSuccess: () => setSaved(true),
    onError: (err) => setError(problemMessage(err, t('common.settingsNotSaved'))),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/teams/{id}', {
        params: { path: { id: team.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void navigate({ to: '/org' }),
    onError: (err) => setError(problemMessage(err, t('team.notDeleted'))),
  });
  const [cleared, setCleared] = useState(false);
  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/teams/{id}/messages', {
        params: { path: { id: team.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => setCleared(true),
    onError: (err) => setError(problemMessage(err, t('team.notCleared'))),
  });
  const names = members.map((bot) => bot.name).join(', ');

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">{t('team.settings')}</h2>
      <form
        className="space-y-4"
        onChange={() => setSaved(false)}
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          setError(null);
          save.mutate(new FormData(event.currentTarget));
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">{t('common.name')}</Label>
            <Input id="team-name" name="name" required maxLength={60} defaultValue={team.name} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-lead">{t('common.lead')}</Label>
            <Select id="team-lead" name="lead" defaultValue={team.leadBotId ?? ''}>
              <option value="">{t('team.noLead')}</option>
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-mission">{t('common.mission')}</Label>
          <Textarea
            id="team-mission"
            name="mission"
            rows={3}
            maxLength={4000}
            defaultValue={team.mission ?? ''}
          />
        </div>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={isolated}
            onChange={(event) => {
              setIsolated(event.target.checked);
              setSaved(false);
            }}
            className="mt-0.5 size-4 accent-white"
          />
          <span>
            <span className="block text-sm">{t('common.isolated')}</span>
            <span className="block text-xs text-muted-foreground">{t('team.isolatedHint')}</span>
          </span>
        </label>
        <FormError message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : saved ? t('common.saved') : t('common.save')}
          </Button>
          {members.length > 0 && (
            <Button
              type="button"
              variant="outline"
              className="ml-auto"
              disabled={clear.isPending}
              onClick={() =>
                confirm(t('team.confirmClear', { name: team.name, bots: names })) && clear.mutate()
              }
            >
              <Eraser className="size-3.5" /> {cleared ? t('team.cleared') : t('team.clear')}
            </Button>
          )}
          {!team.isMain && (
            <Button
              type="button"
              variant="destructive"
              className={cn(members.length === 0 && 'ml-auto')}
              disabled={remove.isPending}
              onClick={() =>
                confirm(
                  members.length > 0
                    ? t('team.confirmDeleteWithBots', { name: team.name, bots: names })
                    : t('team.confirmDelete', { name: team.name }),
                ) && remove.mutate()
              }
            >
              <Trash2 className="size-3.5" /> {t('team.delete')}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

/** A team: its PC and files, its plan of attack, its members, its settings. */
export function TeamPage() {
  const { t } = useTranslation();
  const { teamId } = useParams({ strict: false }) as { teamId?: string };
  const team = useTeam(teamId);
  const bots = useBots();
  const computers = useComputers();
  const dialogs = useOrgDialogs();

  if (team.isPending) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (!team.data) return <p className="text-sm text-destructive">{t('team.notFound')}</p>;
  const current = team.data;
  const members = (bots.data ?? [])
    .filter((b) => b.teamId === current.id)
    .sort((a, b) => Number(b.id === current.leadBotId) - Number(a.id === current.leadBotId));
  const pc = computers.data?.find((c) => c.id === current.computerId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Reveal className="flex flex-wrap items-start gap-4">
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={64} />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="truncate">{current.name}</span>
            {current.isolated && (
              <Lock className="size-4 text-muted-foreground" aria-label={t('common.isolated')} />
            )}
          </h1>
          <p className="text-sm text-muted-foreground">{current.mission ?? t('team.noMission')}</p>
        </div>
        <Button onClick={() => dialogs.newBot(current.id)}>
          <UserPlus className="size-4" /> {t('common.newBot')}
        </Button>
      </Reveal>

      <Reveal delay={0.04} className="flex flex-wrap gap-2">
        <Link
          to="/teams/$teamId/desktop"
          params={{ teamId: current.id }}
          className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:border-white/20"
        >
          <Monitor className="size-4 text-muted-foreground" /> {t('common.teamPc')}
          {pc && <StatusBadge status={pc.status} />}
        </Link>
        <Link
          to="/teams/$teamId/files"
          params={{ teamId: current.id }}
          className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:border-white/20"
        >
          <FolderOpen className="size-4 text-muted-foreground" /> {t('common.files')}
        </Link>
      </Reveal>

      <Reveal delay={0.06}>
        <TeamPlan team={current} bots={bots.data ?? []} />
      </Reveal>

      <section className="space-y-3">
        <h2 className="font-medium">{t('team.members')}</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('team.empty')}</p>
        ) : (
          <motion.div
            initial="hidden"
            animate="shown"
            variants={stagger}
            className="grid gap-3 sm:grid-cols-2"
          >
            {members.map((bot) => (
              <MemberCard key={bot.id} bot={bot} lead={bot.id === current.leadBotId} />
            ))}
          </motion.div>
        )}
      </section>

      <Reveal delay={0.08}>
        <TeamSettings key={current.id} team={current} members={members} />
      </Reveal>
    </div>
  );
}
