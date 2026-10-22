import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { PendingAttachment } from '../../lib/attachments';
import { formatSize } from '../../lib/files';
import { colors, themed } from '../../theme';
import { iconFor } from '../files/file-row';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { useSizeUnits } from './message-files';

const THUMB = 58;

/** What will go with the message: thumbnails of pictures, name and size of files; × removes. */
export function AttachmentStrip({
  files,
  onRemove,
}: {
  files: PendingAttachment[];
  onRemove(id: string): void;
}) {
  const { t, i18n } = useTranslation();
  const units = useSizeUnits();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.row}
    >
      {files.map((file) => {
        const Icon = iconFor({ name: file.name, path: file.name, type: 'file' });
        return (
          <View key={file.id} style={styles.item}>
            {file.image ? (
              <Image
                source={{ uri: file.uri }}
                contentFit="cover"
                accessibilityLabel={file.name}
                style={styles.thumb}
              />
            ) : (
              <View style={styles.file}>
                <Icon size={18} color={colors.textMuted} />
                <View style={styles.titles}>
                  <T variant="footnote" numberOfLines={1} style={styles.name}>
                    {file.name}
                  </T>
                  {file.size !== null && (
                    <T variant="caption" tone="faint">
                      {formatSize(file.size, units, i18n.language)}
                    </T>
                  )}
                </View>
              </View>
            )}
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t('chatMedia.attach.remove', { name: file.name })}
              hitSlop={8}
              onPress={() => onRemove(file.id)}
              style={styles.remove}
            >
              <X size={11} color={colors.text} strokeWidth={2.6} />
            </Touchable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    row: { gap: 10, paddingHorizontal: 4, paddingTop: 8, paddingBottom: 4 },
    item: { paddingTop: 6, paddingRight: 6 },
    thumb: {
      width: THUMB,
      height: THUMB,
      borderRadius: 12,
      borderCurve: 'continuous',
      backgroundColor: colors.surfaceContainerHigh,
    },
    file: {
      height: THUMB,
      width: 168,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 10,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceContainer,
    },
    titles: { flex: 1, minWidth: 0 },
    name: { fontWeight: '600' },
    remove: {
      position: 'absolute',
      top: 0,
      right: 0,
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceContainerHighest,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      overflow: 'hidden',
    },
  }),
);
