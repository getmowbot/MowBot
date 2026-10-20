import type { Bot, Team } from '@mowbot/contract';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Crown, FolderOpen, Lock, Monitor, Settings2, Trash2, UserPlus } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { BotAvatar, TeamAvatar } from '../components/bot-avatar';
import { StatusBadge } from '../components/computer-status';
import { useOrgDialogs } from '../components/org-dialogs';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select, Textarea } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { moodOf, statusLabel } from '../lib/bot-mood';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useComputers, useTeam } from '../lib/queries';
import { cn } from '../lib/utils';

function MemberCard({ bot, lead }: { bot: Bot; lead: boolean }) {
  const dialogs = useOrgDialogs();
  const mood = moodOf(bot);
  return (
    <motion.div variants={reveal} className="glass flex items-center gap-3 rounded-2xl p-3">
      <Link
        to={bot.isChef ? '/' : '/bots/$botId'}
        params={{ botId: bot.id }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <BotAvatar seed={bot.avatarSeed} size={44} mood={mood} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{bot.name}</span>
            {lead && (
              <Crown className="size-3.5 shrink-0 text-muted-foreground" aria-label="Lead" />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{bot.role}</span>
          <span
            className={cn(
              'block truncate text-xs',
              mood === 'idle' ? 'text-faint' : 'shimmer-text',
            )}
          >
            {statusLabel(bot, mood)}
          </span>
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => dialogs.botSettings(bot)}
        aria-label={`Réglages de ${bot.name}`}
      >
        <Settings2 className="size-4" />
      </Button>
    </motion.div>
  );
}

function TeamSettings({ team, members }: { team: Team; members: Bot[] }) {
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
    onError: (err) => setError(problemMessage(err, 'Réglages non enregistrés.')),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/teams/{id}', {
        params: { path: { id: team.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => void navigate({ to: '/org' }),
    onError: (err) => setError(problemMessage(err, 'Équipe non supprimée.')),
  });

  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Réglages de l’équipe</h2>
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
            <Label htmlFor="team-name">Nom</Label>
            <Input id="team-name" name="name" required maxLength={60} defaultValue={team.name} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-lead">Lead</Label>
            <Select id="team-lead" name="lead" defaultValue={team.leadBotId ?? ''}>
              <option value="">Aucun</option>
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-mission">Mission</Label>
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
            <span className="block text-sm">Cloisonnée</span>
            <span className="block text-xs text-muted-foreground">
              Seuls son lead et le Chef peuvent écrire à ses bots.
            </span>
          </span>
        </label>
        <FormError message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Enregistrement…' : saved ? 'Enregistré' : 'Enregistrer'}
          </Button>
          {!team.isMain && (
            <Button
              variant="destructive"
              className="ml-auto"
              disabled={members.length > 0 || remove.isPending}
              title={members.length > 0 ? 'Supprime ou déplace d’abord ses bots' : undefined}
              onClick={() =>
                confirm(
                  `Supprimer l’équipe ${team.name} ? Son PC est supprimé, ses fichiers vont dans la corbeille de l’Équipe principale.`,
                ) && remove.mutate()
              }
            >
              <Trash2 className="size-3.5" /> Supprimer l’équipe
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

/** A team: its members, its PC and files, its settings. */
export function TeamPage() {
  const { teamId } = useParams({ strict: false }) as { teamId?: string };
  const team = useTeam(teamId);
  const bots = useBots();
  const computers = useComputers();
  const dialogs = useOrgDialogs();

  if (team.isPending) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (!team.data) return <p className="text-sm text-destructive">Équipe introuvable.</p>;
  const t = team.data;
  const members = (bots.data ?? [])
    .filter((b) => b.teamId === t.id)
    .sort((a, b) => Number(b.id === t.leadBotId) - Number(a.id === t.leadBotId));
  const pc = computers.data?.find((c) => c.id === t.computerId);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Reveal className="flex flex-wrap items-start gap-4">
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={64} />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <span className="truncate">{t.name}</span>
            {t.isolated && (
              <Lock className="size-4 text-muted-foreground" aria-label="Cloisonnée" />
            )}
          </h1>
          <p className="text-sm text-muted-foreground">{t.mission ?? 'Pas encore de mission.'}</p>
        </div>
        <Button onClick={() => dialogs.newBot(t.id)}>
          <UserPlus className="size-4" /> Nouveau bot
        </Button>
      </Reveal>

      <Reveal delay={0.04} className="flex flex-wrap gap-2">
        <Link
          to="/teams/$teamId/desktop"
          params={{ teamId: t.id }}
          className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:border-white/20"
        >
          <Monitor className="size-4 text-muted-foreground" /> PC de l’équipe
          {pc && <StatusBadge status={pc.status} />}
        </Link>
        <Link
          to="/teams/$teamId/files"
          params={{ teamId: t.id }}
          className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors hover:border-white/20"
        >
          <FolderOpen className="size-4 text-muted-foreground" /> Fichiers
        </Link>
      </Reveal>

      <section className="space-y-3">
        <h2 className="font-medium">Membres</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun bot. Crée-en un, ou demande au Chef de monter l’équipe.
          </p>
        ) : (
          <motion.div
            initial="hidden"
            animate="shown"
            variants={stagger}
            className="grid gap-3 sm:grid-cols-2"
          >
            {members.map((bot) => (
              <MemberCard key={bot.id} bot={bot} lead={bot.id === t.leadBotId} />
            ))}
          </motion.div>
        )}
      </section>

      <Reveal delay={0.08}>
        <TeamSettings key={t.id} team={t} members={members} />
      </Reveal>
    </div>
  );
}
