import type { Connector, Project } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FolderGit2, FolderPlus, FolderSync, Laptop, Link2, Pencil, Unlink } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConflictsDialog, MirrorState } from '../components/project-mirror';
import {
  type ScopeDraft,
  ScopePicker,
  sameScope,
  scopeDraft,
  scopeOf,
  useScopeLabel,
} from '../components/scope-picker';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label } from '../components/ui/form';
import { Switch } from '../components/ui/switch';
import { api, problemMessage } from '../lib/auth';
import { Reveal, reveal, stagger } from '../lib/motion';
import {
  desktop,
  inDesktopApp,
  removeConnector,
  setProject,
  useConnectors,
  useDesktopStatus,
  useProjects,
  useSetMirror,
} from '../lib/projects';
import { useBots, useTeams } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

const Dot = ({ on }: { on: boolean }) => (
  <span
    className={cn('inline-block size-1.5 rounded-full', on ? 'bg-emerald-400' : 'bg-white/25')}
  />
);

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** In the desktop app: link this computer, then share its folders. */
function ThisComputer() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useDesktopStatus();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['desktop-status'] });

  const link = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/connectors', {
        body: { name: status.data?.hostname || t('projects.thisPc') },
      });
      if (error || !data) throw error;
      await desktop.link(data.token);
    },
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (err) => setError(problemMessage(err, t('projects.linkFailed'))),
  });
  const share = useMutation({
    mutationFn: async () => {
      const path = await desktop.pickFolder();
      if (path) await desktop.share(folderName(path), path);
    },
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const data = status.data;
  return (
    <Reveal className="glass flex flex-wrap items-center gap-3 rounded-2xl p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.05]">
        <Laptop className="size-5 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 font-medium">
          {data?.hostname || t('projects.thisPc')}
          {data?.linked && <Dot on={data.connected} />}
        </p>
        <p className="text-sm text-muted-foreground">
          {!data
            ? t('common.loading')
            : !data.linked
              ? t('projects.notLinked')
              : data.connected
                ? t('projects.connected', { count: data.projects.length })
                : (data.lastError ?? t('projects.connecting'))}
        </p>
        <FormError message={error} />
      </div>
      {data &&
        (data.linked ? (
          <Button onClick={() => share.mutate()} disabled={share.isPending}>
            <FolderPlus className="size-4" /> {t('projects.share')}
          </Button>
        ) : (
          <Button onClick={() => link.mutate()} disabled={link.isPending}>
            <Link2 className="size-4" /> {t('projects.link')}
          </Button>
        ))}
    </Reveal>
  );
}

function ProjectForm({ project, onDone }: { project: Project; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [scope, setScope] = useState<ScopeDraft>(scopeDraft(project.scope));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const next = scopeOf(scope);
      const { data, error } = await api.PATCH('/api/v1/projects/{id}', {
        params: { path: { id: project.id } },
        body: {
          ...(name.trim() !== project.name ? { name: name.trim() } : {}),
          ...(sameScope(next, project.scope) ? {} : { scope: next }),
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved) => {
      setProject(queryClient, saved);
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('projects.saveFailed'))),
  });
  const empty = scope.kind !== 'all' && scope[scope.kind].length === 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !empty) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="project-name">{t('projects.name')}</Label>
        <Input
          id="project-name"
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <ScopePicker value={scope} onChange={setScope} />
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!name.trim() || empty || save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function ProjectCard({
  project,
  computer,
  local,
  onEdit,
}: {
  project: Project;
  computer: Connector | undefined;
  /** Shared from this very computer: it can be unshared here. */
  local: boolean;
  onEdit(): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const scope = useScopeLabel(project.scope);
  const mode = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.PATCH('/api/v1/projects/{id}', {
        params: { path: { id: project.id } },
        body: { mode: project.mode === 'auto' ? 'ask' : 'auto' },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved) => setProject(queryClient, saved),
  });
  const unshare = useMutation({
    mutationFn: () => desktop.unshare(project.key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['desktop-status'] }),
  });
  const where = computer?.hostname ?? computer?.name ?? '…';
  const setMirror = useSetMirror(project);
  const teams = useTeams();
  const bots = useBots();
  const [conflictsIn, setConflictsIn] = useState<string | null>(null);
  /** Whose workspace a mirror is in: a team's, or a solo bot's. */
  const owner = (workspaceId: string) =>
    teams.data?.find((team) => team.workspaceId === workspaceId)?.name ??
    bots.data?.find((bot) => bot.workspaceId === workspaceId)?.name ??
    '…';
  return (
    <motion.li variants={reveal} className="glass rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.05]">
          <FolderGit2 className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{project.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{project.path}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-faint">
            <Dot on={project.online} />
            {t(project.online ? 'projects.onlineOn' : 'projects.offlineOn', { computer: where })}
            {' · '}
            {scope}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label={t('projects.edit')}>
          <Pencil className="size-4" />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm">{t('projects.auto')}</p>
          <p className="text-xs text-muted-foreground">
            {project.mode === 'auto' ? t('projects.autoOn') : t('projects.autoOff')}
          </p>
        </div>
        <Switch
          checked={project.mode === 'auto'}
          onChange={() => mode.mutate()}
          label={t('projects.auto')}
        />
      </div>
      <div className="mt-3 space-y-2 border-t border-border pt-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">{t('projects.mirror.title')}</p>
            <p className="text-xs text-muted-foreground">
              {project.mirror ? t('projects.mirror.on') : t('projects.mirror.off')}
            </p>
          </div>
          <Switch
            checked={project.mirror}
            onChange={() => {
              if (setMirror.isPending) return;
              if (
                !project.mirror ||
                project.mirrors.length === 0 ||
                confirm(t('projects.mirror.offConfirm', { name: project.name }))
              ) {
                setMirror.mutate(!project.mirror);
              }
            }}
            label={t('projects.mirror.title')}
          />
        </div>
        {project.mirror && project.mirrors.length === 0 && (
          <p className="text-xs text-faint">{t('projects.mirror.none')}</p>
        )}
        {project.mirrors.map((mirror) => (
          <div
            key={mirror.workspaceId}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-xs"
          >
            <FolderSync className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              {t('projects.mirror.of', { who: owner(mirror.workspaceId) })}
            </span>
            <Link
              to="/workspaces/$workspaceId/files"
              params={{ workspaceId: mirror.workspaceId }}
              search={{ path: mirror.folder }}
              className="font-mono text-faint hover:text-foreground hover:underline"
            >
              /workspace/{mirror.folder}
            </Link>
            <span className="text-faint">·</span>
            <MirrorState
              mirror={mirror}
              online={project.online}
              onConflicts={() => setConflictsIn(mirror.workspaceId)}
            />
            {mirror.error && mirror.status !== 'synced' && (
              <p className="w-full text-faint">{mirror.error}</p>
            )}
          </div>
        ))}
        {setMirror.isError && (
          <p className="text-xs text-destructive">
            {problemMessage(setMirror.error, t('projects.saveFailed'))}
          </p>
        )}
      </div>
      {local && (
        <div className="mt-3 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={unshare.isPending}
            onClick={() => {
              if (confirm(t('projects.unshareConfirm', { name: project.name }))) unshare.mutate();
            }}
          >
            {t('projects.unshare')}
          </Button>
        </div>
      )}
      <ConflictsDialog
        project={project}
        mirror={project.mirrors.find((m) => m.workspaceId === conflictsIn) ?? null}
        open={conflictsIn !== null}
        onClose={() => setConflictsIn(null)}
      />
    </motion.li>
  );
}

function ComputerRow({ computer }: { computer: Connector }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const unlink = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/connectors/{id}', {
        params: { path: { id: computer.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      removeConnector(queryClient, computer.id);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const details = [
    computer.hostname && computer.hostname !== computer.name ? computer.hostname : null,
    computer.os,
    computer.online
      ? t('projects.online')
      : computer.lastSeenAt
        ? t('projects.lastSeen', { time: timeAgo(computer.lastSeenAt) })
        : t('projects.neverSeen'),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Laptop className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm">
          {computer.name} <Dot on={computer.online} />
        </p>
        <p className="truncate text-xs text-muted-foreground">{details}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={unlink.isPending}
        onClick={() => {
          if (confirm(t('projects.unlinkConfirm', { name: computer.name }))) unlink.mutate();
        }}
      >
        <Unlink className="size-4" /> {t('projects.unlink')}
      </Button>
    </li>
  );
}

/** Folders of the user's computers where bots work, like a code assistant would. */
export function ProjectsPage() {
  const { t } = useTranslation();
  const projects = useProjects();
  const computers = useConnectors();
  const status = useDesktopStatus();
  const [editId, setEditId] = useState<string | null>(null);
  const list = projects.data ?? [];
  const editing = list.find((project) => project.id === editId);
  const localKeys = new Set((status.data?.projects ?? []).map((folder) => folder.key));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">{t('shell.projects')}</h1>
        <p className="text-sm text-muted-foreground">{t('projects.subtitle')}</p>
      </Reveal>

      {inDesktopApp() ? (
        <ThisComputer />
      ) : (
        <Reveal className="glass flex items-start gap-3 rounded-2xl p-4">
          <Laptop className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('projects.getDesktop')}</p>
        </Reveal>
      )}

      {projects.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {projects.isSuccess && list.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('projects.empty')}</p>
      )}
      {list.length > 0 && (
        <motion.ul initial="hidden" animate="shown" variants={stagger} className="space-y-3">
          {list.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              computer={computers.data?.find((c) => c.id === project.connectorId)}
              local={localKeys.has(project.key)}
              onEdit={() => setEditId(project.id)}
            />
          ))}
        </motion.ul>
      )}

      {(computers.data?.length ?? 0) > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{t('projects.computers')}</h2>
          <ul className="glass divide-y divide-border rounded-2xl">
            {computers.data?.map((computer) => (
              <ComputerRow key={computer.id} computer={computer} />
            ))}
          </ul>
        </section>
      )}

      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditId(null)}
        className="max-w-xl"
        title={editing?.name ?? ''}
        description={editing?.path}
      >
        {editing && (
          <ProjectForm key={editing.id} project={editing} onDone={() => setEditId(null)} />
        )}
      </Dialog>
    </div>
  );
}
