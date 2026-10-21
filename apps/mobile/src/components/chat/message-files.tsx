import type { MessagePart } from '@mowbot/contract';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { fileCanvasRoute, fileExtension } from '../../lib/board';
import { formatSize, type SizeUnit } from '../../lib/files';
import { colors } from '../../theme';
import { GalleryBody } from '../board/gallery-body';
import { iconFor } from '../files/file-row';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

/** Size units as the files browser words them. */
export function useSizeUnits(): Record<SizeUnit, string> {
  const { t } = useTranslation();
  return {
    b: t('filesView.units.b'),
    kb: t('filesView.units.kb'),
    mb: t('filesView.units.mb'),
    gb: t('filesView.units.gb'),
    tb: t('filesView.units.tb'),
  };
}

/** A file the user sent: its icon, name and size; tapping it opens it in the files browser. */
function FileCard({ part }: { part: AttachmentPart }) {
  const { t, i18n } = useTranslation();
  const units = useSizeUnits();
  const Icon = iconFor({ name: part.name, path: part.path, type: 'file' });
  const extension = fileExtension(part.name);
  const size = formatSize(part.size, units, i18n.language);
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={t('chatMedia.attach.open', { name: part.name })}
      onPress={() =>
        router.push(fileCanvasRoute(part.workspaceId, { path: part.path, type: 'file' }))
      }
      style={styles.card}
    >
      <View style={styles.icon}>
        <Icon size={20} color={colors.textMuted} strokeWidth={2} />
      </View>
      <View style={styles.titles}>
        <T variant="callout" numberOfLines={1} style={styles.name}>
          {part.name}
        </T>
        <T variant="caption" tone="muted" numberOfLines={1}>
          {extension ? `${size}  ·  ${extension}` : size}
        </T>
      </View>
    </Touchable>
  );
}

/** What the user attached: pictures as on a bot's gallery (full screen on a tap), then files. */
export function MessageFiles({
  pictures,
  files,
  version,
}: {
  pictures: AttachmentPart[];
  files: AttachmentPart[];
  /** The message's id: its pictures never change. */
  version: string;
}) {
  const first = pictures[0];
  return (
    <View style={styles.stack}>
      {first && (
        <GalleryBody
          content={{ kind: 'gallery', images: pictures.map((part) => ({ src: part.path })) }}
          workspaceId={first.workspaceId}
          version={version}
        />
      )}
      {files.map((part) => (
        <FileCard key={part.path} part={part} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { width: '85%', gap: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceContainer,
    overflow: 'hidden',
  },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  titles: { flex: 1, minWidth: 0, gap: 1 },
  name: { fontWeight: '600' },
});
