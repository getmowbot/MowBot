import type { CanvasContent } from '@mowbot/contract';
import { X } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Modal, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GALLERY_GAP, galleryThumbSize, isWebLink, SINGLE_IMAGE_RATIO } from '../../lib/board';
import { alertError } from '../../lib/options-menu';
import { IconButton } from '../ui/button';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { CanvasImage } from './canvas-image';
import { openWebLink } from './card-body';

type Gallery = Extract<CanvasContent, { kind: 'gallery' }>;
type Picture = Gallery['images'][number];

interface Props {
  content: Gallery;
  /** The bot's workspace, for pictures stored there. */
  workspaceId: string | null;
  /** Changes when the pictures may have changed. */
  version: string;
}

/** Full screen, one picture per page (swipe for the others), its caption below. */
function Viewer({
  images,
  start,
  workspaceId,
  version,
  onClose,
}: {
  images: Picture[];
  start: number;
  workspaceId: string | null;
  version: string;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [current, setCurrent] = useState(start);
  const caption = images[current]?.caption;

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.viewer} accessibilityViewIsModal>
        <FlatList
          data={images}
          horizontal
          pagingEnabled
          initialScrollIndex={start}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          keyExtractor={(_, index) => String(index)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) =>
            setCurrent(Math.round(event.nativeEvent.contentOffset.x / width))
          }
          renderItem={({ item, index }) => (
            <View style={[styles.page, { width, height }]}>
              <CanvasImage
                src={item.src}
                workspaceId={workspaceId}
                alt={
                  item.caption ||
                  t('board.canvas.picture', { index: index + 1, count: images.length })
                }
                version={version}
                contentFit="contain"
                // Room left above and below for the close button and the caption.
                style={{ width, height: Math.max(200, height - insets.top - insets.bottom - 120) }}
              />
            </View>
          )}
        />
        <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          {images.length > 1 ? (
            <T variant="footnote" style={styles.counter}>
              {current + 1} / {images.length}
            </T>
          ) : (
            <View />
          )}
          <IconButton icon={X} label={t('common.close')} onPress={onClose} raised />
        </View>
        {caption ? (
          <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
            <T variant="callout" style={styles.caption}>
              {caption}
            </T>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/**
 * Pictures side by side: one takes the whole width; more sit in a row of rounded thumbnails
 * (scrolling past two). Tapping one opens its page, or shows it full screen.
 */
export function GalleryBody({ content, workspaceId, version }: Props) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const { images } = content;
  const size = galleryThumbSize(images.length, width);
  const single = images.length === 1;

  const open = (index: number) => {
    const url = images[index]?.url;
    if (url && isWebLink(url)) openWebLink(url, () => alertError(t('common.actionFailed')));
    else setViewing(index);
  };

  const thumb = (image: Picture, index: number) => {
    const alt =
      image.caption || t('board.canvas.picture', { index: index + 1, count: images.length });
    const link = image.url && isWebLink(image.url);
    return (
      <Touchable
        key={index}
        accessibilityRole={link ? 'link' : 'imagebutton'}
        accessibilityLabel={alt}
        accessibilityHint={link ? t('board.canvas.opensPage') : undefined}
        onPress={() => open(index)}
        style={[styles.thumb, { width: size }]}
      >
        <CanvasImage
          src={image.src}
          workspaceId={workspaceId}
          alt={alt}
          version={version}
          style={
            single
              ? [styles.picture, styles.single]
              : [styles.picture, { width: size, height: size }]
          }
        />
        {image.caption ? (
          <T variant="caption" tone="muted" numberOfLines={2} style={styles.thumbCaption}>
            {image.caption}
          </T>
        ) : null}
      </Touchable>
    );
  };

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {width === 0 ? null : single ? (
        images[0] && thumb(images[0], 0)
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
          // A swipe on the row scrolls it, not the page around it.
          nestedScrollEnabled
        >
          {images.map(thumb)}
        </ScrollView>
      )}
      {viewing !== null && (
        <Viewer
          images={images}
          start={viewing}
          workspaceId={workspaceId}
          version={version}
          onClose={() => setViewing(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: GALLERY_GAP },
  thumb: { gap: 6, borderRadius: 12 },
  picture: { borderRadius: 12, borderCurve: 'continuous' },
  single: { width: '100%', aspectRatio: SINGLE_IMAGE_RATIO },
  thumbCaption: { paddingHorizontal: 2 },
  // Viewer
  viewer: { flex: 1, backgroundColor: '#000' },
  page: { alignItems: 'center', justifyContent: 'center' },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  counter: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20 },
  caption: { textAlign: 'center' },
});
