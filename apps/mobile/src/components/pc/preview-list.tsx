import type { Preview } from '@mowbot/contract';
import * as Clipboard from 'expo-clipboard';
import { Copy, Ellipsis, EllipsisVertical, ExternalLink, Globe, Square } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { currentLanguage } from '../../i18n';
import { alertError, confirm, openOptions, showInfo } from '../../lib/options-menu';
import { isAndroid } from '../../lib/platform';
import { usePreviews, useStopPreview } from '../../lib/preview-queries';
import { untilLabel } from '../../lib/previews';
import { colors, spacing } from '../../theme';
import { IconButton } from '../ui/button';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

function PreviewRow({
  preview,
  botName,
  onStop,
}: {
  preview: Preview;
  botName: string | null;
  onStop(): void;
}) {
  const { t } = useTranslation();
  // The phone's browser: it has no hub session, the link's secret lets it in.
  const open = () =>
    void Linking.openURL(preview.url).catch(() => alertError(t('common.actionFailed')));
  const copy = () =>
    void Clipboard.setStringAsync(preview.url).then(() => showInfo(t('pcView.previews.copied')));
  const stop = () =>
    void confirm(
      t('pcView.previews.stop'),
      t('pcView.previews.confirmStop', { title: preview.title }),
      { label: t('pcView.previews.stop'), destructive: true },
    ).then((ok) => ok && onStop());
  const meta = t(botName ? 'pcView.previews.metaBot' : 'pcView.previews.meta', {
    port: preview.port,
    bot: botName ?? '',
    until: untilLabel(preview.expiresAt, currentLanguage()),
  });

  return (
    <Surface style={styles.row}>
      <Touchable
        accessibilityRole="link"
        accessibilityLabel={`${t('pcView.previews.open')} ${preview.title}`}
        onPress={open}
        style={styles.main}
      >
        <Globe size={18} color={colors.textMuted} strokeWidth={2} />
        <View style={styles.text}>
          <T variant="callout" numberOfLines={1}>
            {preview.title}
          </T>
          <T variant="caption" tone="muted" numberOfLines={1}>
            {meta}
          </T>
        </View>
      </Touchable>
      <IconButton
        icon={isAndroid ? EllipsisVertical : Ellipsis}
        label={t('pcView.previews.options')}
        onPress={() =>
          openOptions({
            title: preview.title,
            options: [
              { label: t('pcView.previews.open'), icon: ExternalLink, onPress: open },
              { label: t('pcView.previews.copy'), icon: Copy, onPress: copy },
              {
                label: t('pcView.previews.stop'),
                icon: Square,
                destructive: true,
                onPress: stop,
              },
            ],
          })
        }
      />
    </Surface>
  );
}

/** The web pages bots shared from this PC: tap to open in the browser; copy the link, stop. */
export function PreviewList({
  computerId,
  botNames,
}: {
  computerId: string;
  botNames: Map<string, string>;
}) {
  const { t } = useTranslation();
  const previews = usePreviews(computerId);
  const stop = useStopPreview(computerId);
  const items = previews.data ?? [];
  if (items.length === 0) return null;

  return (
    <View style={styles.list}>
      <T variant="overline" tone="faint">
        {t('pcView.previews.title')}
      </T>
      {items.map((preview) => (
        <PreviewRow
          key={preview.id}
          preview={preview}
          botName={preview.botId ? (botNames.get(preview.botId) ?? null) : null}
          onStop={() =>
            stop.mutate(preview.id, { onError: () => alertError(t('common.actionFailed')) })
          }
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.xs,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
  },
  text: { flex: 1, minWidth: 0 },
});
