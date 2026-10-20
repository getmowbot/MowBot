import type { Bot, BotComputerChoice, Team } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { FolderOpen, Monitor, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { createContext, type FormEvent, type ReactNode, useContext, useState } from 'react';
import { api, problemMessage } from '../lib/auth';
import { useComputers, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { FormError, Input, Label, Select, Textarea } from './ui/form';

interface OrgDialogs {
  newTeam(): void;
  newBot(teamId?: string | null): void;
  botSettings(bot: Bot): void;
}

const OrgDialogsContext = createContext<OrgDialogs | null>(null);

export function useOrgDialogs(): OrgDialogs {
  const value = useContext(OrgDialogsContext);
  if (!value) throw new Error('useOrgDialogs outside OrgDialogsProvider');
  return value;
}

/** Two or three mutually exclusive options, as pills with a gliding highlight. */
function Choice<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: { value: T; label: string; hint: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'relative rounded-xl border px-3 py-2.5 text-left transition-colors duration-200',
            value === option.value
              ? 'border-primary/50'
              : 'border-border-strong text-muted-foreground hover:border-white/20',
          )}
        >
          {value === option.value && (
            <motion.span
              layoutId={`choice-${name}`}
              transition={springs.soft}
              className="absolute inset-0 rounded-xl bg-primary/[0.08]"
            />
          )}
          <span className="relative block text-sm font-medium text-foreground">{option.label}</span>
          <span className="relative block text-xs text-muted-foreground">{option.hint}</span>
        </button>
      ))}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 accent-white"
      />
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function NewTeamForm({ onDone }: { onDone(): void }) {
  const navigate = useNavigate();
  const [isolated, setIsolated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const mission = String(form.get('mission') ?? '').trim();
      const { data, error } = await api.POST('/api/v1/teams', {
        body: { name: String(form.get('name')).trim(), mission: mission || undefined, isolated },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (team) => {
      onDone();
      void navigate({ to: '/teams/$teamId', params: { teamId: team.id } });
    },
    onError: (err) => setError(problemMessage(err, 'Équipe non créée.')),
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
        <Label htmlFor="team-name">Nom</Label>
        <Input
          id="team-name"
          name="name"
          required
          maxLength={60}
          autoFocus
          placeholder="Marketing"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="team-mission">Mission</Label>
        <Textarea
          id="team-mission"
          name="mission"
          rows={3}
          maxLength={4000}
          placeholder="Ce dont l'équipe s'occupe, sur la durée"
        />
      </div>
      <Check
        checked={isolated}
        onChange={setIsolated}
        label="Cloisonnée"
        hint="Seuls son lead et le Chef peuvent écrire à ses bots. Pour les données sensibles."
      />
      <p className="text-xs text-muted-foreground">
        L’équipe a son propre PC (allumé au premier besoin) et son propre dossier de fichiers.
      </p>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Création…' : 'Créer l’équipe'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

function NewBotForm({ teamId, onDone }: { teamId: string | null; onDone(): void }) {
  const navigate = useNavigate();
  const teams = useTeams();
  const [team, setTeam] = useState<string>(teamId ?? teams.data?.[0]?.id ?? 'solo');
  const [computer, setComputer] = useState<BotComputerChoice>('team');
  const [lead, setLead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const solo = team === 'solo';
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const mission = String(form.get('mission') ?? '').trim();
      const { data, error } = await api.POST('/api/v1/bots', {
        body: {
          name: String(form.get('name')).trim(),
          role: String(form.get('role')).trim(),
          mission: mission || undefined,
          teamId: solo ? null : team,
          computer: solo ? 'dedicated' : computer,
          lead: !solo && lead,
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (bot) => {
      onDone();
      void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
    },
    onError: (err) => setError(problemMessage(err, 'Bot non créé.')),
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
          <Label htmlFor="bot-name">Nom</Label>
          <Input id="bot-name" name="name" required maxLength={40} autoFocus placeholder="Nova" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-role">Rôle</Label>
          <Input
            id="bot-role"
            name="role"
            required
            maxLength={120}
            placeholder="Veille concurrentielle"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bot-mission">Mission</Label>
        <Textarea
          id="bot-mission"
          name="mission"
          rows={3}
          maxLength={4000}
          placeholder="Ce qu'il doit accomplir, ce qu'on attend de lui"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="bot-team">Équipe</Label>
        <Select id="bot-team" value={team} onChange={(event) => setTeam(event.target.value)}>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value="solo">Solo (hors équipe)</option>
        </Select>
      </div>
      {solo ? (
        <p className="text-xs text-muted-foreground">
          Un bot solo a son propre PC et son propre dossier de fichiers.
        </p>
      ) : (
        <>
          <Choice<BotComputerChoice>
            name="computer"
            value={computer}
            onChange={setComputer}
            options={[
              { value: 'team', label: 'PC de l’équipe', hint: 'Partagé avec ses collègues' },
              { value: 'dedicated', label: 'PC dédié', hint: 'Rien qu’à lui (lourd ou sensible)' },
            ]}
          />
          <Check
            checked={lead}
            onChange={setLead}
            label="Lead de l’équipe"
            hint="Il répartit le travail et peut créer des bots dans l’équipe."
          />
        </>
      )}
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Création…' : 'Créer le bot'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

function BotSettingsForm({ bot, onDone }: { bot: Bot; onDone(): void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const teams = useTeams();
  const computers = useComputers();
  const team: Team | undefined = teams.data?.find((t) => t.id === bot.teamId);
  const pc = computers.data?.find((c) => c.id === bot.computerId);
  const [lead, setLead] = useState(team?.leadBotId === bot.id);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const { error } = await api.PATCH('/api/v1/bots/{id}', {
        params: { path: { id: bot.id } },
        body: {
          role: String(form.get('role')).trim(),
          mission: String(form.get('mission') ?? '').trim() || null,
        },
      });
      if (error) throw error;
      if (team && lead !== (team.leadBotId === bot.id)) {
        const { error: teamError } = await api.PATCH('/api/v1/teams/{id}', {
          params: { path: { id: team.id } },
          body: { leadBotId: lead ? bot.id : null },
        });
        if (teamError) throw teamError;
      }
    },
    onSuccess: onDone,
    onError: (err) => setError(problemMessage(err, 'Réglages non enregistrés.')),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/bots/{id}', { params: { path: { id: bot.id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.setQueryData<Bot[]>(['bots'], (list) => list?.filter((b) => b.id !== bot.id));
      onDone();
      void navigate({ to: '/' });
    },
    onError: (err) => setError(problemMessage(err, 'Bot non supprimé.')),
  });
  const filesLink = team
    ? { to: '/teams/$teamId/files', params: { teamId: team.id } }
    : bot.workspaceId
      ? { to: '/workspaces/$workspaceId/files', params: { workspaceId: bot.workspaceId } }
      : null;

  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="settings-role">Rôle</Label>
        <Input id="settings-role" name="role" required maxLength={120} defaultValue={bot.role} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-mission">Mission</Label>
        <Textarea
          id="settings-mission"
          name="mission"
          rows={4}
          maxLength={4000}
          defaultValue={bot.mission ?? ''}
        />
      </div>
      {team && !bot.isChef && (
        <Check checked={lead} onChange={setLead} label={`Lead de l’équipe ${team.name}`} />
      )}
      <div className="flex flex-wrap gap-2 text-sm">
        {pc && (
          <Link
            to="/computers/$computerId"
            params={{ computerId: pc.id }}
            onClick={onDone}
            className="flex items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Monitor className="size-3.5" />{' '}
            {pc.kind === 'dedicated' ? 'Son PC dédié' : 'PC de l’équipe'}
          </Link>
        )}
        {filesLink && (
          <Link
            {...filesLink}
            onClick={onDone}
            className="flex items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <FolderOpen className="size-3.5" /> Fichiers
          </Link>
        )}
      </div>
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Enregistrement…' : 'Enregistrer'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Annuler
        </Button>
        {!bot.isChef && (
          <Button
            variant="destructive"
            className="ml-auto"
            disabled={remove.isPending}
            onClick={() => {
              const what =
                pc?.kind === 'dedicated'
                  ? ', sa conversation et son PC dédié'
                  : ' et sa conversation';
              if (
                confirm(
                  `Supprimer ${bot.name}${what} ?${team ? '' : ' Ses fichiers iront dans la corbeille de l’Équipe principale.'}`,
                )
              ) {
                remove.mutate();
              }
            }}
          >
            <Trash2 className="size-3.5" /> Supprimer
          </Button>
        )}
      </div>
    </form>
  );
}

/** Opens the org dialogs (new team, new bot, bot settings) from anywhere in the app. */
export function OrgDialogsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<
    | { kind: 'team' }
    | { kind: 'bot'; teamId: string | null }
    | { kind: 'settings'; bot: Bot }
    | null
  >(null);
  const close = () => setOpen(null);
  const value: OrgDialogs = {
    newTeam: () => setOpen({ kind: 'team' }),
    newBot: (teamId = null) => setOpen({ kind: 'bot', teamId }),
    botSettings: (bot) => setOpen({ kind: 'settings', bot }),
  };
  return (
    <OrgDialogsContext.Provider value={value}>
      {children}
      <Dialog
        open={open?.kind === 'team'}
        onClose={close}
        title="Nouvelle équipe"
        description="Un groupe de bots avec son PC partagé et ses fichiers."
      >
        <NewTeamForm onDone={close} />
      </Dialog>
      <Dialog
        open={open?.kind === 'bot'}
        onClose={close}
        title="Nouveau bot"
        description="Il rejoint une équipe, ou travaille seul sur son propre PC."
      >
        <NewBotForm teamId={open?.kind === 'bot' ? open.teamId : null} onDone={close} />
      </Dialog>
      <Dialog
        open={open?.kind === 'settings'}
        onClose={close}
        title={
          open?.kind === 'settings' ? (
            <span className="flex items-center gap-2.5">
              <BotAvatar seed={open.bot.avatarSeed} size={28} /> {open.bot.name}
            </span>
          ) : (
            ''
          )
        }
      >
        {open?.kind === 'settings' && <BotSettingsForm bot={open.bot} onDone={close} />}
      </Dialog>
    </OrgDialogsContext.Provider>
  );
}
