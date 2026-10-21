import type { Connector, Project } from '@mowbot/contract';
import { ChevronRight, FolderCode, Laptop, Unlink } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { isIOS } from '../../lib/platform';
import { connectorHint, projectHint, shortPath } from '../../lib/projects';
import { colors, fonts } from '../../theme';
import { Dot } from '../admin/parts';
import { IconButton } from '../ui/button';
import { ListRow, ROW_INSET } from '../ui/rows';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/** Online: the bots can reach it now. */
export const presenceColor = (online: boolean) => (online ? colors.accentStrong : colors.textFaint);

/** A path in monospace: cut in the middle on one line, or whole (and selectable). */
export function PathText({ path, whole = false }: { path: string; whole?: boolean }) {
  return whole ? (
    <T variant="footnote" tone="muted" selectable style={styles.mono}>
      {path}
    </T>
  ) : (
    <T variant="footnote" tone="muted" numberOfLines={1} ellipsizeMode="middle" style={styles.mono}>
      {shortPath(path)}
    </T>
  );
}

/** A shared folder: its name, where it is, on which computer (online or not), its mode. */
export function ProjectRow({
  project,
  connectors,
  onPress,
}: {
  project: Project;
  connectors: Connector[] | undefined;
  onPress(): void;
}) {
  const { t } = useTranslation();
  return (
    <Touchable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <FolderCode size={20} color={colors.textMuted} />
      <View style={styles.text}>
        <T variant="body" numberOfLines={1}>
          {project.name}
        </T>
        <PathText path={project.path} />
        <T variant="footnote" tone="muted" numberOfLines={2}>
          {projectHint(project, connectors, t)}
        </T>
      </View>
      <Dot color={presenceColor(project.online)} />
      <ChevronRight size={18} color={colors.textFaint} />
    </Touchable>
  );
}

/** A linked computer: what its app reported, its shared folders, and a way to unlink it. */
export function ConnectorRow({
  connector,
  projects,
  onUnlink,
  disabled,
}: {
  connector: Connector;
  projects: Project[] | undefined;
  onUnlink(): void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <ListRow
      icon={Laptop}
      label={connector.name}
      hint={connectorHint(connector, projects, t, i18n.language)}
      disabled={disabled}
      accessory={
        <View style={styles.accessory}>
          <Dot color={presenceColor(connector.online)} />
          <IconButton
            icon={Unlink}
            label={t('projects.computers.unlinkLabel', { name: connector.name })}
            onPress={onUnlink}
            color={colors.textMuted}
          />
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  // Same measures as ListRow (components/ui/rows), with a third line.
  row: {
    minHeight: isIOS ? 52 : 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: ROW_INSET,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  mono: { fontFamily: fonts.mono, fontSize: 12.5 },
  accessory: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: -8 },
});
