import type { Connector, Project } from '@mowbot/contract';
import { router } from 'expo-router';
import { FolderCode } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { ConnectorRow, ProjectRow } from '../../../components/projects/parts';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { ICON_ROW_INSET } from '../../../components/ui/rows';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import { alertError, confirm } from '../../../lib/options-menu';
import { sortConnectors, sortProjects } from '../../../lib/projects';
import {
  projectError,
  useConnectors,
  useProjects,
  useUnlinkConnector,
} from '../../../lib/projects-queries';
import { colors } from '../../../theme';

/** Nothing shared yet: where folders come from. */
function EmptyProjects() {
  const { t } = useTranslation();
  return (
    <Surface style={styles.empty}>
      <FolderCode size={28} color={colors.textMuted} strokeWidth={1.8} />
      <T variant="headline">{t('projects.emptyState.title')}</T>
      <T variant="footnote" tone="muted">
        {t('projects.emptyState.install')}
      </T>
      <T variant="footnote" tone="muted">
        {t('projects.emptyState.share')}
      </T>
    </Surface>
  );
}

/** The computers whose desktop app is linked to the hub, each one unlinkable. */
function Computers({
  connectors,
  projects,
}: {
  connectors: Connector[];
  projects: Project[] | undefined;
}) {
  const { t } = useTranslation();
  const unlink = useUnlinkConnector();

  const askUnlink = async (connector: Connector) => {
    const ok = await confirm(
      t('projects.computers.unlinkConfirm', { name: connector.name }),
      t('projects.computers.unlinkHint'),
      { label: t('projects.computers.unlink'), destructive: true },
    );
    if (!ok) return;
    unlink.mutate(connector.id, {
      onError: (err) => alertError(projectError(err, t('common.actionFailed'))),
    });
  };

  return (
    <Section title={t('projects.computers.title')}>
      <ListCard inset={ICON_ROW_INSET}>
        {sortConnectors(connectors).map((connector) => (
          <ConnectorRow
            key={connector.id}
            connector={connector}
            projects={projects}
            disabled={unlink.isPending && unlink.variables === connector.id}
            onUnlink={() => void askUnlink(connector)}
          />
        ))}
      </ListCard>
    </Section>
  );
}

/** Folders of the user's computers where bots work, like a code assistant would. */
export default function ProjectsScreen() {
  const { t } = useTranslation();
  const projects = useProjects();
  const connectors = useConnectors();
  const list = sortProjects(projects.data ?? []);
  const computers = connectors.data ?? [];

  return (
    <Screen
      title={t('projects.title')}
      onRefresh={() => Promise.all([projects.refetch(), connectors.refetch()])}
    >
      <Note>{t('projects.intro')}</Note>
      {projects.isPending ? (
        <Loading />
      ) : projects.isError ? (
        <LoadError message={t('projects.loadFailed')} onRetry={() => void projects.refetch()} />
      ) : list.length === 0 ? (
        <EmptyProjects />
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {list.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              connectors={connectors.data}
              onPress={() => router.push(`/projects/${project.id}`)}
            />
          ))}
        </ListCard>
      )}
      {list.length > 0 ? <Note>{t('projects.desktopNote')}</Note> : null}
      {computers.length > 0 ? <Computers connectors={computers} projects={projects.data} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 20, gap: 10 },
});
