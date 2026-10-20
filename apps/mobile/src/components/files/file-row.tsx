import type { FileEntry } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import {
  Ellipsis,
  FileArchive,
  FileBraces,
  FileCode,
  File as FileGeneric,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileText,
  Folder,
  type LucideIcon,
  Trash2,
} from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { type FileKind, fileKind, formatSize, TRASH_FOLDER } from '../../lib/files';
import { isAndroid, isIOS } from '../../lib/platform';
import { timeAgo } from '../../lib/time';
import { colors, shape } from '../../theme';
import { IconButton } from '../ui/button';
import { ICON_ROW_INSET, ROW_INSET } from '../ui/rows';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

const KIND_ICONS: Record<FileKind, LucideIcon> = {
  markdown: FileText,
  text: FileText,
  code: FileCode,
  image: FileImage,
  pdf: FileText,
  audio: FileMusic,
  video: FilePlay,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  other: FileGeneric,
};

/** `1,5 Mo · il y a 5 min` for a file, the time alone for a folder. */
export function useEntryMeta(): (entry: Pick<FileEntry, 'type' | 'size' | 'modifiedAt'>) => string {
  const { t, i18n } = useTranslation();
  const units = {
    b: t('filesView.units.b'),
    kb: t('filesView.units.kb'),
    mb: t('filesView.units.mb'),
    gb: t('filesView.units.gb'),
    tb: t('filesView.units.tb'),
  };
  return (entry) => {
    const when = timeAgo(entry.modifiedAt, t, i18n.language);
    return entry.type === 'file'
      ? `${formatSize(entry.size, units, i18n.language)}  ·  ${when}`
      : when;
  };
}

/** The icon of an entry: folder, trash, or one per kind of file. */
export function iconFor(entry: Pick<FileEntry, 'name' | 'path' | 'type'>): LucideIcon {
  if (entry.path === TRASH_FOLDER) return Trash2;
  if (entry.type === 'directory') return Folder;
  if (/\.jsonl?$/i.test(entry.name)) return FileBraces;
  return KIND_ICONS[fileKind(entry.name)];
}

interface FileRowProps {
  entry: FileEntry;
  label: string;
  meta: string;
  /** Position in its card: the first and last rows carry its rounded corners. */
  first: boolean;
  last: boolean;
  onPress(): void;
  /** ⋯ button and long press. */
  onOptions?(): void;
  optionsLabel: string;
}

/**
 * One entry of a folder, drawn as a slice of a ListCard (rows of a virtualized list cannot share
 * one Surface): same paddings, icon size and divider inset as `ListRow`, so everything lines up.
 */
export function FileRow({
  entry,
  label,
  meta,
  first,
  last,
  onPress,
  onOptions,
  optionsLabel,
}: FileRowProps) {
  const Icon = iconFor(entry);
  const folder = entry.type === 'directory';
  return (
    <CardSlice first={first} last={last}>
      <Touchable
        accessibilityRole="button"
        accessibilityHint={meta}
        onPress={onPress}
        onLongPress={
          onOptions
            ? () => {
                void Haptics.selectionAsync();
                onOptions();
              }
            : undefined
        }
        style={styles.row}
      >
        <Icon size={20} color={folder ? colors.text : colors.textMuted} strokeWidth={2} />
        <View style={styles.text}>
          <T variant="body" numberOfLines={1}>
            {label}
          </T>
          <T variant="footnote" tone="muted" numberOfLines={1}>
            {meta}
          </T>
        </View>
        {onOptions ? (
          <View style={styles.more}>
            <IconButton
              icon={Ellipsis}
              label={optionsLabel}
              onPress={onOptions}
              size={36}
              color={colors.textMuted}
            />
          </View>
        ) : null}
      </Touchable>
    </CardSlice>
  );
}

/** A piece of a card: borders and corners of a `Surface` card, split across list rows. */
export function CardSlice({
  first,
  last,
  children,
}: {
  first: boolean;
  last: boolean;
  children: ReactNode;
}) {
  return (
    <View style={[styles.slice, first && styles.sliceFirst, last && styles.sliceLast]}>
      {!first && <View style={styles.divider} />}
      {children}
    </View>
  );
}

/** Something under way (an upload, a download), above the list. */
export function BusyBanner({ label }: { label: string }) {
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <ActivityIndicator size="small" color={colors.textMuted} />
      <T variant="footnote" tone="muted" numberOfLines={1} style={styles.text}>
        {label}
      </T>
    </View>
  );
}

const hairline = StyleSheet.hairlineWidth;

const styles = StyleSheet.create({
  slice: {
    backgroundColor: isAndroid ? colors.surfaceContainer : colors.surface,
    overflow: 'hidden',
    borderCurve: 'continuous',
    ...(!isAndroid && {
      borderLeftWidth: hairline,
      borderRightWidth: hairline,
      borderColor: colors.borderStrong,
    }),
  },
  sliceFirst: {
    borderTopLeftRadius: shape.card,
    borderTopRightRadius: shape.card,
    ...(!isAndroid && { borderTopWidth: hairline }),
  },
  sliceLast: {
    borderBottomLeftRadius: shape.card,
    borderBottomRightRadius: shape.card,
    ...(!isAndroid && { borderBottomWidth: hairline }),
  },
  divider: {
    position: 'absolute',
    top: 0,
    left: ICON_ROW_INSET,
    right: 0,
    height: hairline,
    backgroundColor: colors.border,
    zIndex: 1,
  },
  row: {
    minHeight: isIOS ? 60 : 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: ROW_INSET,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  // The ⋯ glyph lines up with the chevrons of ListRow (its button is wider than the glyph).
  more: { marginRight: -10 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: ROW_INSET,
    paddingVertical: 10,
    borderRadius: shape.card,
    backgroundColor: isAndroid ? colors.surfaceContainer : colors.surface,
  },
});
