import type { FileEntry } from '@mowbot/contract';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { Ellipsis, FolderOpen, Trash2, Upload } from 'lucide-react-native';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BusyBanner, FileRow, useEntryMeta } from '../../../components/files/file-row';
import { useFileActions } from '../../../components/files/use-file-actions';
import { Screen } from '../../../components/screen';
import { Button, IconButton } from '../../../components/ui/button';
import { T } from '../../../components/ui/text';
import { displayName, isInTrash, pathSegments, TRASH_FOLDER } from '../../../lib/files';
import { useFolder, useWorkspaceOwner } from '../../../lib/files-queries';
import { colors, spacing } from '../../../theme';

/**
 * A folder of a workspace (a team's or a solo bot's files). A subfolder is the same screen
 * pushed with another `path`, so the system back goes up one folder.
 */
export default function FilesScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; path?: string }>();
  const workspaceId = params.workspaceId;
  const dir = params.path ?? '';
  const { t } = useTranslation();
  const metaOf = useEntryMeta();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const folder = useFolder(workspaceId, dir, { poll: focused });
  const owner = useWorkspaceOwner(workspaceId);
  const ownerName = owner.name ?? (owner.pending ? null : t('filesView.title'));
  const actions = useFileActions({ workspaceId, dir, ownerName });
  const [refreshing, setRefreshing] = useState(false);
  const trashLabel = t('filesView.trash');
  const inTrash = isInTrash(dir);

  const title = dir ? displayName(dir, trashLabel) : (ownerName ?? t('filesView.title'));
  // Where we are, under the title: the owner, then each folder down to this one.
  const segments = pathSegments(dir);
  const crumbs = dir
    ? [
        ownerName ?? t('filesView.title'),
        ...segments.map((_, index) =>
          displayName(segments.slice(0, index + 1).join('/'), trashLabel),
        ),
      ].join('  /  ')
    : null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await folder.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const open = (entry: FileEntry) =>
    router.push(
      entry.type === 'directory'
        ? { pathname: '/files/[workspaceId]', params: { workspaceId, path: entry.path } }
        : { pathname: '/files/[workspaceId]/view', params: { workspaceId, path: entry.path } },
    );

  const entries = folder.data ?? [];
  const renderItem: ListRenderItem<FileEntry> = ({ item, index }) => {
    const label = displayName(item.path, trashLabel);
    return (
      <FileRow
        entry={item}
        label={label}
        meta={metaOf(item)}
        first={index === 0}
        last={index === entries.length - 1}
        onPress={() => open(item)}
        onOptions={() => actions.openEntryMenu(item)}
        optionsLabel={t('filesView.entryOptions', { name: label })}
      />
    );
  };

  const header =
    crumbs || actions.busy || inTrash ? (
      <View style={styles.header}>
        {crumbs ? (
          <T variant="footnote" tone="faint" numberOfLines={2} style={styles.indent}>
            {crumbs}
          </T>
        ) : null}
        {inTrash && dir === TRASH_FOLDER ? (
          <T variant="footnote" tone="muted" style={styles.indent}>
            {t('filesView.trashHint')}
          </T>
        ) : null}
        {actions.busy ? <BusyBanner label={actions.busy} /> : null}
      </View>
    ) : null;

  let empty: ReactElement;
  if (folder.isPending) {
    empty = (
      <View style={styles.state}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  } else if (folder.isError) {
    empty = (
      <View style={styles.state}>
        <T variant="body" tone="muted" style={styles.center}>
          {t('filesView.notFound')}
        </T>
        <Button variant="secondary" label={t('common.retry')} onPress={() => void refresh()} />
      </View>
    );
  } else {
    empty = (
      <View style={styles.state}>
        {inTrash ? (
          <Trash2 size={36} color={colors.textFaint} strokeWidth={1.6} />
        ) : (
          <FolderOpen size={36} color={colors.textFaint} strokeWidth={1.6} />
        )}
        <T variant="headline" style={styles.center}>
          {t(inTrash ? 'filesView.emptyTrash' : 'filesView.empty')}
        </T>
        {!inTrash && (
          <>
            <T variant="footnote" tone="muted" style={styles.center}>
              {t('filesView.emptyHint')}
            </T>
            <Button
              variant="secondary"
              icon={Upload}
              label={t('filesView.upload')}
              onPress={actions.upload}
            />
          </>
        )}
      </View>
    );
  }

  return (
    <Screen
      title={title}
      scroll={false}
      headerRight={() => (
        <IconButton
          icon={Ellipsis}
          label={t('filesView.folderOptions')}
          onPress={actions.openFolderMenu}
        />
      )}
    >
      <FlatList
        data={entries}
        keyExtractor={(entry) => entry.path}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.textMuted}
            colors={[colors.accentInk]}
            progressBackgroundColor={colors.accentStrong}
          />
        }
      />
      {actions.element}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, flexGrow: 1 },
  header: { gap: spacing.md, marginBottom: spacing.md },
  indent: { paddingHorizontal: spacing.xs },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
  },
  center: { textAlign: 'center' },
});
