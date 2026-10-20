import type { FileEntry } from '@mowbot/contract';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Share, Share2 } from 'lucide-react-native';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import { displayName, formatSize, TEXT_PREVIEW_BYTES, textChunks } from '../../lib/files';
import { downloadToCache, useImageSource } from '../../lib/files-queries';
import { isIOS } from '../../lib/platform';
import { colors, fonts, spacing } from '../../theme';
import { Markdown } from '../markdown';
import { Button } from '../ui/button';
import { T } from '../ui/text';
import { iconFor, useEntryMeta } from './file-row';

export function PreviewLoading() {
  return (
    <View style={styles.state}>
      <ActivityIndicator color={colors.textMuted} />
    </View>
  );
}

export function PreviewMessage({ message, hint }: { message: string; hint?: string }) {
  return (
    <View style={styles.state}>
      <T variant="body" tone="muted" style={styles.center}>
        {message}
      </T>
      {hint ? (
        <T variant="footnote" tone="faint" style={styles.center}>
          {hint}
        </T>
      ) : null}
    </View>
  );
}

function TruncatedNote() {
  const { t, i18n } = useTranslation();
  const size = formatSize(
    TEXT_PREVIEW_BYTES,
    {
      b: t('filesView.units.b'),
      kb: t('filesView.units.kb'),
      mb: t('filesView.units.mb'),
      gb: t('filesView.units.gb'),
      tb: t('filesView.units.tb'),
    },
    i18n.language,
  );
  return (
    <T variant="footnote" tone="faint" style={styles.note}>
      {t('filesView.preview.truncated', { size })}
    </T>
  );
}

/** Text and code: monospace, wrapped, laid out in blocks of lines as the list scrolls. */
export function TextPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const insets = useSafeAreaInsets();
  const chunks = useMemo(() => textChunks(text), [text]);
  return (
    <FlatList
      data={chunks}
      // Chunks never reorder: their position is their identity.
      keyExtractor={(_, index) => String(index)}
      renderItem={({ item }) => (
        <T variant="footnote" selectable style={styles.mono}>
          {item}
        </T>
      )}
      initialNumToRender={2}
      windowSize={5}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.text, { paddingBottom: insets.bottom + spacing.xxl }]}
      ListFooterComponent={truncated ? <TruncatedNote /> : null}
    />
  );
}

/** A Markdown document, laid out (its source is one tap away in the header). */
export function MarkdownPreview({ text, truncated }: { text: string; truncated: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.document, { paddingBottom: insets.bottom + spacing.xxl }]}
    >
      <Markdown text={text} />
      {truncated ? <TruncatedNote /> : null}
    </ScrollView>
  );
}

/**
 * An image loaded from the hub with the session's bearer header (pinch to zoom on iOS). A
 * failure is retried once with a token checked again, then reported.
 */
export function ImagePreview({ workspaceId, entry }: { workspaceId: string; entry: FileEntry }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const source = useImageSource(workspaceId, entry, attempt);
  if (failed) return <PreviewMessage message={t('filesView.preview.failed')} />;
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={box ?? styles.fill}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setBox({ width, height });
      }}
      maximumZoomScale={isIOS ? 5 : 1}
      minimumZoomScale={1}
      bouncesZoom
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {!loaded && (
        <View style={StyleSheet.absoluteFill}>
          <PreviewLoading />
        </View>
      )}
      {box && source ? (
        <Image
          key={attempt}
          source={source}
          style={box}
          contentFit="contain"
          // Private files: never written to the disk cache.
          cachePolicy="memory"
          transition={120}
          accessibilityLabel={displayName(entry.path, t('filesView.trash'))}
          onLoad={() => setLoaded(true)}
          onError={() => {
            if (attempt === 0) setAttempt(1);
            else setFailed(true);
          }}
        />
      ) : null}
    </ScrollView>
  );
}

/**
 * iOS draws PDFs in a web view: the file is downloaded to the cache first (a web view cannot
 * send the bearer header past the first request), then shown from there, with no scripts.
 */
export function PdfPreview({
  workspaceId,
  entry,
  fallback,
}: {
  workspaceId: string;
  entry: FileEntry;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const local = useQuery({
    queryKey: ['file-local', workspaceId, entry.path, entry.modifiedAt],
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async () =>
      (await downloadToCache(workspaceId, entry.path, entry.name, { slot: 'preview' })).uri,
  });
  if (failed || local.isError) return fallback;
  if (!local.data) return <PreviewLoading />;
  return (
    <WebView
      source={{ uri: local.data }}
      originWhitelist={['file://*']}
      javaScriptEnabled={false}
      style={styles.web}
      containerStyle={styles.web}
      onError={() => setFailed(true)}
    />
  );
}

/** No preview in the app: hand the file to another app. */
export function OpenWith({ entry, onShare }: { entry: FileEntry; onShare(): void }) {
  const { t } = useTranslation();
  const metaOf = useEntryMeta();
  const Icon = iconFor(entry);
  return (
    <View style={styles.state}>
      <Icon size={48} color={colors.textMuted} strokeWidth={1.5} />
      <View style={styles.titles}>
        <T variant="headline" style={styles.center} numberOfLines={3}>
          {displayName(entry.path, t('filesView.trash'))}
        </T>
        <T variant="footnote" tone="muted" style={styles.center}>
          {metaOf(entry)}
        </T>
      </View>
      <T variant="callout" tone="muted" style={styles.center}>
        {t('filesView.preview.none')} {t('filesView.preview.noneHint')}
      </T>
      <Button
        label={t('filesView.preview.openWith')}
        icon={isIOS ? Share : Share2}
        onPress={onShare}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  titles: { alignItems: 'center', gap: spacing.xs },
  center: { textAlign: 'center' },
  text: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  mono: { fontFamily: fonts.mono, fontSize: 12.5, lineHeight: 19, color: colors.text },
  document: { padding: spacing.lg, paddingTop: spacing.md },
  note: { marginTop: spacing.lg, textAlign: 'center' },
  web: { flex: 1, backgroundColor: colors.background },
});
