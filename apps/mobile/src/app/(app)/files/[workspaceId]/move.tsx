import { router, useLocalSearchParams } from 'expo-router';
import { CornerLeftUp, Folder, FolderInput } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ListCard } from '../../../../components/list-card';
import { FormActions, Screen } from '../../../../components/screen';
import { Button } from '../../../../components/ui/button';
import { ICON_ROW_INSET, ListRow } from '../../../../components/ui/rows';
import { T } from '../../../../components/ui/text';
import {
  canMoveInto,
  displayName,
  isInTrash,
  moveTarget,
  normalizePath,
  parentOf,
  pathSegments,
  TRASH_FOLDER,
} from '../../../../lib/files';
import { useFileMutations, useFolder, useWorkspaceOwner } from '../../../../lib/files-queries';
import { problemCode } from '../../../../lib/hub-url';
import { alertError } from '../../../../lib/options-menu';
import { colors, spacing } from '../../../../theme';

/**
 * Picks the folder an entry moves to (or is restored to, out of the trash). The picker walks
 * the folders in place, then goes back to where the user was.
 */
export default function MoveScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; from: string }>();
  const workspaceId = params.workspaceId;
  const from = normalizePath(params.from);
  const { t } = useTranslation();
  const trashLabel = t('filesView.trash');
  // Restoring starts from the root: the original folder of a trashed entry is not known.
  const [dir, setDir] = useState(() => (isInTrash(from) ? '' : parentOf(from)));
  const folder = useFolder(workspaceId, dir);
  const owner = useWorkspaceOwner(workspaceId);
  const { move } = useFileMutations(workspaceId);
  const name = displayName(from, trashLabel);

  // Folders to go into: not the entry itself (a folder cannot go into itself) nor the trash.
  const folders = (folder.data ?? []).filter(
    (entry) => entry.type === 'directory' && entry.path !== from && entry.path !== TRASH_FOLDER,
  );
  const here = [
    owner.name ?? t('filesView.title'),
    ...pathSegments(dir).map((_, index, all) =>
      displayName(all.slice(0, index + 1).join('/'), trashLabel),
    ),
  ].join('  /  ');
  const allowed = canMoveInto(from, dir) && !isInTrash(dir);

  const submit = () =>
    move.mutate(
      { from, to: moveTarget(from, dir) },
      {
        onSuccess: () => router.back(),
        onError: (error) =>
          alertError(
            problemCode(error) === 'already_exists'
              ? t('filesView.alreadyExists')
              : t('common.actionFailed'),
          ),
      },
    );

  return (
    <Screen title={t('filesView.moveTitle')}>
      <View style={styles.intro}>
        <T variant="callout" tone="muted">
          {t('filesView.moveSubtitle', { name })}
        </T>
        <View style={styles.here}>
          <FolderInput size={16} color={colors.textMuted} />
          <T variant="footnote" style={styles.hereText} numberOfLines={2}>
            {here}
          </T>
        </View>
      </View>

      {folder.isPending ? (
        <ActivityIndicator color={colors.textMuted} />
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {dir ? (
            <ListRow
              key=".."
              icon={CornerLeftUp}
              label={t('filesView.parentFolder')}
              onPress={() => setDir(parentOf(dir))}
              chevron={false}
            />
          ) : null}
          {folders.map((entry) => (
            <ListRow
              key={entry.path}
              icon={Folder}
              label={displayName(entry.path, trashLabel)}
              onPress={() => setDir(entry.path)}
            />
          ))}
          {folders.length === 0 ? (
            <ListRow key="none" label={t('filesView.noSubfolders')} disabled />
          ) : null}
        </ListCard>
      )}

      <FormActions>
        {dir === parentOf(from) && !isInTrash(from) ? (
          <T variant="footnote" tone="faint" style={styles.center}>
            {t('filesView.alreadyHere')}
          </T>
        ) : null}
        <Button
          label={move.isPending ? t('filesView.moving') : t('filesView.moveHere')}
          icon={FolderInput}
          loading={move.isPending}
          disabled={!allowed}
          onPress={submit}
        />
        <Button variant="secondary" label={t('common.cancel')} onPress={() => router.back()} />
      </FormActions>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { gap: spacing.md, paddingHorizontal: spacing.xs },
  here: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hereText: { flex: 1 },
  center: { textAlign: 'center' },
});
