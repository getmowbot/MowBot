import type { Bot, Connector, Project, Team } from '@mowbot/contract';
import { useLocalSearchParams } from 'expo-router';
import { Pencil } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import {
  Caption,
  FormError,
  LoadError,
  Loading,
  Note,
  StatusText,
} from '../../../components/admin/parts';
import { useNamePrompt } from '../../../components/files/name-prompt';
import { ListCard } from '../../../components/list-card';
import { ScopePicker } from '../../../components/mcp/parts';
import { PathText, presenceColor } from '../../../components/projects/parts';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ListRow, ROW_INSET, SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { liveScope, type ScopeNames, sameScope, scopeProblem } from '../../../lib/mcp';
import { alertError, confirm } from '../../../lib/options-menu';
import {
  computerSummary,
  connectorName,
  mirrorText,
  modeBody,
  nameProblem,
  renameBody,
} from '../../../lib/projects';
import {
  projectError,
  useConnectors,
  useDismissConflicts,
  useProject,
  useUpdateProject,
} from '../../../lib/projects-queries';
import { useBots, useTeams } from '../../../lib/queries';

/** Asks for a new name, then saves it (nothing sent when unchanged). */
function useRename(project: Project | undefined) {
  const { t } = useTranslation();
  const prompt = useNamePrompt();
  const save = useUpdateProject();

  const ask = () => {
    if (!project) return;
    prompt.ask({
      title: t('projects.rename.title'),
      message: t('projects.rename.message'),
      initial: project.name,
      confirmLabel: t('projects.rename.action'),
      onSubmit: (typed) => {
        const problem = nameProblem(typed);
        if (problem) {
          alertError(t(`projects.problems.${problem}`));
          return;
        }
        const body = renameBody(project, typed);
        if (!body) return;
        save.mutate(
          { id: project.id, body },
          { onError: (err) => alertError(projectError(err, t('projects.rename.notSaved'))) },
        );
      },
    });
  };

  return { ask, element: prompt.element, pending: save.isPending };
}

/** Its name, where it is, and the computer it is on (online or last seen). */
function Info({
  project,
  connector,
  connectors,
  onRename,
  renaming,
}: {
  project: Project;
  connector: Connector | undefined;
  connectors: Connector[] | undefined;
  onRename(): void;
  renaming: boolean;
}) {
  const { t, i18n } = useTranslation();
  const computer = connectorName(project.connectorId, connectors, t);
  return (
    <Section title={t('projects.info.title')}>
      <ListCard inset={ROW_INSET}>
        <ListRow
          label={t('projects.info.name')}
          value={project.name}
          disabled={renaming}
          onPress={onRename}
        />
        <View style={styles.pathRow}>
          <T variant="body">{t('projects.info.path')}</T>
          <PathText path={project.path} whole />
        </View>
        <ListRow
          label={t('projects.info.computer')}
          hint={connector ? computerSummary(connector, t, i18n.language) : undefined}
          accessory={<StatusText color={presenceColor(project.online)} label={computer} />}
        />
      </ListCard>
      {project.online ? null : <Note>{t('projects.info.offlineNote', { computer })}</Note>}
    </Section>
  );
}

/** "Commandes sans demander": auto runs them freely, otherwise each one waits for the user. */
function Mode({ project }: { project: Project }) {
  const { t } = useTranslation();
  const toggle = useUpdateProject();
  // The switch follows the tap right away, then the hub's answer.
  const pending = toggle.isPending ? toggle.variables?.body.mode : undefined;
  const mode = pending ?? project.mode;

  const setAuto = (auto: boolean) =>
    toggle.mutate(
      { id: project.id, body: modeBody(auto) },
      { onError: (err) => alertError(projectError(err, t('projects.mode.notSaved'))) },
    );

  return (
    <Section title={t('projects.mode.title')}>
      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('projects.mode.auto')}
          hint={t('projects.mode.hint')}
          value={mode === 'auto'}
          onChange={setAuto}
          disabled={toggle.isPending}
        />
      </ListCard>
    </Section>
  );
}

/**
 * The copy in the bots' workspaces: on or off, how each one stands, and the files both sides
 * changed (dismissed to the trash).
 */
function Mirror({
  project,
  bots,
  teams,
}: {
  project: Project;
  bots: Bot[] | undefined;
  teams: Team[] | undefined;
}) {
  const { t } = useTranslation();
  const toggle = useUpdateProject();
  const dismiss = useDismissConflicts();
  const pending = toggle.isPending ? toggle.variables?.body.mirror : undefined;
  const on = pending ?? project.mirror;
  const owner = (workspaceId: string) =>
    teams?.find((team) => team.workspaceId === workspaceId)?.name ??
    bots?.find((bot) => bot.workspaceId === workspaceId)?.name ??
    '…';

  const setMirror = async (mirror: boolean) => {
    if (
      !mirror &&
      project.mirrors.length > 0 &&
      !(await confirm(t('projects.mirror.offTitle'), t('projects.mirror.offConfirm'), {
        label: t('projects.mirror.offAction'),
        destructive: true,
      }))
    ) {
      return;
    }
    toggle.mutate(
      { id: project.id, body: { mirror } },
      { onError: (err) => alertError(projectError(err, t('projects.mirror.notSaved'))) },
    );
  };
  const drop = (workspaceId: string, path?: string) =>
    dismiss.mutate(
      { id: project.id, workspaceId, path },
      { onError: (err) => alertError(projectError(err, t('projects.conflicts.notDismissed'))) },
    );

  return (
    <Section title={t('projects.mirror.title')}>
      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('projects.mirror.label')}
          hint={on ? t('projects.mirror.on') : t('projects.mirror.off')}
          value={on}
          onChange={(value) => void setMirror(value)}
          disabled={toggle.isPending}
        />
        {project.mirrors.map((mirror) => (
          <ListRow
            key={mirror.workspaceId}
            label={t('projects.mirror.of', { who: owner(mirror.workspaceId) })}
            hint={`/workspace/${mirror.folder}\n${mirrorText(mirror, project.online, t)}${
              mirror.error && mirror.status !== 'synced' ? `\n${mirror.error}` : ''
            }`}
          />
        ))}
      </ListCard>
      {project.mirror && project.mirrors.length === 0 ? (
        <Caption>{t('projects.mirror.none')}</Caption>
      ) : null}
      {project.mirrors
        .filter((mirror) => mirror.conflicts.length > 0)
        .map((mirror) => (
          <View key={`conflicts-${mirror.workspaceId}`} style={styles.conflicts}>
            <T variant="footnote" tone="muted">
              {`${t('projects.conflicts.title')} · ${t('projects.mirror.conflicts', {
                count: mirror.conflicts.length,
              })}`}
            </T>
            <Note>{t('projects.conflicts.intro')}</Note>
            <ListCard inset={ROW_INSET}>
              {mirror.conflicts.map((conflict) => (
                <ListRow
                  key={`${conflict.path}-${conflict.at}`}
                  label={conflict.path}
                  hint={t('projects.conflicts.copy', { path: conflict.copy })}
                  disabled={dismiss.isPending}
                  onPress={() =>
                    void confirm(t('projects.conflicts.dismiss'), conflict.path, {
                      label: t('projects.conflicts.dismiss'),
                    }).then((ok) => ok && drop(mirror.workspaceId, conflict.path))
                  }
                />
              ))}
            </ListCard>
            <Caption>{t('projects.conflicts.dismissHint')}</Caption>
            <Button
              label={t('projects.conflicts.dismissAll')}
              variant="secondary"
              onPress={() => drop(mirror.workspaceId)}
              loading={dismiss.isPending}
            />
          </View>
        ))}
    </Section>
  );
}

/** All bots, some teams or some bots, saved with its own button. */
function Scope({
  project,
  bots,
  teams,
}: {
  project: Project;
  /** Undefined while loading: the ids are kept as they are. */
  bots: Bot[] | undefined;
  teams: Team[] | undefined;
}) {
  const { t } = useTranslation();
  const save = useUpdateProject();
  const names: ScopeNames = { bots, teams };
  const [base, setBase] = useState(project.scope);
  const [scope, setScope] = useState(project.scope);
  const [error, setError] = useState<string | null>(null);
  // Teams and bots deleted since are neither shown nor sent back.
  const next = liveScope(scope, names);
  const dirty = !sameScope(next, liveScope(project.scope, names));

  // Changed elsewhere (another device) or just saved: follow it unless being edited.
  if (base !== project.scope) {
    if (!dirty) setScope(project.scope);
    setBase(project.scope);
  }

  const submit = () => {
    if (scopeProblem(next)) {
      setError(t('projects.problems.scope'));
      return;
    }
    setError(null);
    save.mutate(
      { id: project.id, body: { scope: next } },
      {
        onSuccess: (saved) => setScope(saved.scope),
        onError: (err) => setError(projectError(err, t('projects.scope.notSaved'))),
      },
    );
  };

  return (
    <Section title={t('projects.scope.title')}>
      <ScopePicker
        scope={next}
        onChange={(changed) => {
          setScope(changed);
          setError(null);
        }}
        bots={bots ?? []}
        teams={teams ?? []}
      />
      <FormError message={error} />
      {dirty ? <Button label={t('common.save')} onPress={submit} loading={save.isPending} /> : null}
    </Section>
  );
}

function ProjectDetail({
  project,
  connectors,
  bots,
  teams,
  onRename,
  renaming,
}: {
  project: Project;
  connectors: Connector[] | undefined;
  bots: Bot[] | undefined;
  teams: Team[] | undefined;
  onRename(): void;
  renaming: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Info
        project={project}
        connector={connectors?.find((c) => c.id === project.connectorId)}
        connectors={connectors}
        onRename={onRename}
        renaming={renaming}
      />
      <Mode project={project} />
      <Mirror project={project} bots={bots} teams={teams} />
      <Scope project={project} bots={bots} teams={teams} />
      <Caption>
        {t('projects.info.unshareNote', {
          computer: connectorName(project.connectorId, connectors, t),
        })}
      </Caption>
    </>
  );
}

/** One shared folder: where it is, commands with or without asking, who may use it, its name. */
export default function ProjectScreen() {
  const { t } = useTranslation();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const project = useProject(projectId);
  const connectors = useConnectors();
  const bots = useBots();
  const teams = useTeams();
  const data = project.data;
  const rename = useRename(data);

  return (
    <Screen
      title={data?.name ?? t('projects.title')}
      headerRight={
        data
          ? () => (
              <IconButton icon={Pencil} label={t('projects.rename.title')} onPress={rename.ask} />
            )
          : undefined
      }
      onRefresh={() =>
        Promise.all([project.refetch(), connectors.refetch(), bots.refetch(), teams.refetch()])
      }
    >
      {project.isPending ? (
        <Loading />
      ) : project.isError ? (
        <LoadError message={t('projects.loadFailed')} onRetry={() => void project.refetch()} />
      ) : data ? (
        <ProjectDetail
          key={data.id}
          project={data}
          connectors={connectors.data}
          bots={bots.data}
          teams={teams.data}
          onRename={rename.ask}
          renaming={rename.pending}
        />
      ) : (
        <Note>{t('projects.notFound')}</Note>
      )}
      {rename.element}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pathRow: { paddingHorizontal: ROW_INSET, paddingVertical: 12, gap: 2 },
  conflicts: { gap: 8, marginTop: 12 },
});
