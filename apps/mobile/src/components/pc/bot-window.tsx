import type { Bot, BotBrowser } from '@mowbot/contract';
import { Image } from 'expo-image';
import { Globe } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { DEFAULT_ASPECT, fitBox, type Size } from '../../lib/desktop';
import { colors, shape, spacing } from '../../theme';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';

interface Props {
  bot: Bot;
  /** The latest capture (polled by the screen while shown). */
  page: BotBrowser | undefined;
  loading: boolean;
}

/**
 * A bot's own Chrome window: it browses off-screen, so the PC's screen does not show it. A
 * capture refreshed every 1.5 s, fitted to the width.
 */
export function BotWindow({ bot, page, loading }: Props) {
  const { t } = useTranslation();
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [area, setArea] = useState<Size>({ width: 0, height: 0 });

  if (!page?.open || !page.image) {
    return (
      <View style={styles.root}>
        <Surface style={styles.empty}>
          {loading ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <>
              <Globe size={28} color={colors.textFaint} strokeWidth={1.75} />
              <T variant="headline" style={styles.center}>
                {t('pcView.noPage', { name: bot.name })}
              </T>
              <T variant="footnote" tone="muted" style={styles.center}>
                {t('pcView.noPageHint')}
              </T>
            </>
          )}
        </Surface>
      </View>
    );
  }

  const box = fitBox(area, aspect);
  return (
    <View style={styles.root}>
      <View style={styles.titleRow}>
        <Globe size={16} color={colors.textMuted} />
        <View style={styles.titleText}>
          <T variant="callout" numberOfLines={1} style={styles.title}>
            {page.title || page.url}
          </T>
          {page.url ? (
            <T variant="caption" tone="faint" numberOfLines={1}>
              {page.url}
            </T>
          ) : null}
        </View>
      </View>
      <View
        style={styles.imageArea}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setArea({ width, height });
        }}
      >
        <Image
          source={{ uri: `data:image/jpeg;base64,${page.image}` }}
          accessibilityLabel={t('pcView.botPage', { name: bot.name })}
          contentFit="contain"
          contentPosition="top"
          // A new capture every 1.5 s: keep none of them, and swap without a fade.
          cachePolicy="none"
          transition={0}
          onLoad={(event) => {
            const { width, height } = event.source;
            if (width > 0 && height > 0) setAspect(width / height);
          }}
          style={[styles.image, { width: box.width, height: box.height }]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, gap: spacing.md },
  empty: {
    width: '100%',
    aspectRatio: DEFAULT_ASPECT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  center: { textAlign: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
  titleText: { flex: 1, minWidth: 0 },
  title: { fontWeight: '600' },
  imageArea: { flex: 1, alignItems: 'center' },
  image: {
    backgroundColor: '#000',
    borderRadius: shape.field,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
});
