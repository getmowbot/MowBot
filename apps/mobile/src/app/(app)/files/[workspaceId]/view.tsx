import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { Code, Ellipsis, FileText } from 'lucide-react-native';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { BusyBanner } from '../../../../components/files/file-row';
import {
  ImagePreview,
  MarkdownPreview,
  OpenWith,
  PdfPreview,
  PreviewLoading,
  PreviewMessage,
  TextPreview,
} from '../../../../components/files/previews';
import { useFileActions } from '../../../../components/files/use-file-actions';
import { Screen } from '../../../../components/screen';
import { IconButton } from '../../../../components/ui/button';
import { displayName, normalizePath, parentOf, previewKind } from '../../../../lib/files';
import { useFileEntry, useFileText, useWorkspaceOwner } from '../../../../lib/files-queries';
import { isIOS } from '../../../../lib/platform';
import { spacing } from '../../../../theme';

/**
 * A file of a workspace: text and code in monospace, Markdown laid out (or its source),
 * images, PDFs on iOS; anything else goes to another app through the share sheet.
 */
export default function FilePreviewScreen() {
  const params = useLocalSearchParams<{ workspaceId: string; path: string }>();
  const workspaceId = params.workspaceId;
  const path = normalizePath(params.path);
  const { t } = useTranslation();
  const focused = useIsFocused();
  const owner = useWorkspaceOwner(workspaceId);
  const file = useFileEntry(workspaceId, path, { poll: focused });
  const entry = file.entry;
  const [source, setSource] = useState(false);
  // A folder (an @ mention can point at one): its listing instead.
  const folder = entry?.type === 'directory';
  useEffect(() => {
    if (folder) router.replace({ pathname: '/files/[workspaceId]', params: { workspaceId, path } });
  }, [folder, workspaceId, path]);
  const actions = useFileActions({
    workspaceId,
    dir: parentOf(path),
    ownerName: owner.name,
    onRenamed: (to) => router.setParams({ path: to }),
    onDeleted: () => (router.canGoBack() ? router.back() : router.replace('/')),
  });

  const kind = entry ? previewKind(entry.name, entry.size) : null;
  const textual = kind === 'text' || kind === 'markdown';
  const content = useFileText(workspaceId, entry, textual);
  const text = content.data;

  const openWith = entry ? <OpenWith entry={entry} onShare={() => actions.share(entry)} /> : null;

  let body: ReactNode;
  if (!entry) {
    body = file.isPending ? (
      <PreviewLoading />
    ) : (
      <PreviewMessage message={t('filesView.fileNotFound')} />
    );
  } else if (textual) {
    if (content.isError) body = <PreviewMessage message={t('filesView.preview.failed')} />;
    else if (!text) body = <PreviewLoading />;
    else if (kind === 'markdown' && !source) body = <MarkdownPreview {...text} />;
    else body = <TextPreview {...text} />;
  } else if (kind === 'image') {
    body = <ImagePreview workspaceId={workspaceId} entry={entry} />;
  } else if (kind === 'pdf' && isIOS) {
    body = <PdfPreview workspaceId={workspaceId} entry={entry} fallback={openWith} />;
  } else {
    body = openWith;
  }

  return (
    <Screen
      title={displayName(path, t('filesView.trash'))}
      scroll={false}
      headerRight={() =>
        entry ? (
          <View style={styles.header}>
            {kind === 'markdown' && (
              <IconButton
                icon={source ? FileText : Code}
                label={t(source ? 'filesView.preview.rendered' : 'filesView.preview.source')}
                onPress={() => setSource((value) => !value)}
              />
            )}
            <IconButton
              icon={Ellipsis}
              label={t('filesView.entryOptions', { name: entry.name })}
              onPress={() => actions.openEntryMenu(entry, { move: false })}
            />
          </View>
        ) : null
      }
    >
      {body}
      {actions.busy ? (
        <View style={styles.banner} pointerEvents="none">
          <BusyBanner label={actions.busy} />
        </View>
      ) : null}
      {actions.element}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  banner: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: spacing.xxl },
});
