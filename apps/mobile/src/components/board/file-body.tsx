import type { CanvasContent } from '@mowbot/contract';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Share, Share2 } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import {
  FILE_MARKDOWN_LINES,
  FILE_PREVIEW_HEIGHT,
  FILE_TEXT_LINES,
  fileCanvasRoute,
  fileExtension,
  fileImageHeight,
  filePreview,
  textExcerpt,
} from '../../lib/board';
import { formatSize } from '../../lib/files';
import { useFileHead } from '../../lib/files-queries';
import { problemCode } from '../../lib/hub-url';
import { isIOS } from '../../lib/platform';
import { colors, fonts, themed, tint } from '../../theme';
import { iconFor } from '../files/file-row';
import { useShareEntry } from '../files/use-file-actions';
import { Markdown } from '../markdown';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { Pill } from './pill';
import { WorkspaceImage } from './workspace-image';

type FileCanvas = Extract<CanvasContent, { kind: 'file' }>;

const ShareIcon = isIOS ? Share : Share2;
/** The inset well a text shows in (solid, so the fade blends into it). */
/** The well the file sits in (read when used: it follows the look). */
const well = () => colors.background;
const WELL_PADDING = 12;

interface Props {
  content: FileCanvas;
  /** The bot's workspace, where the file is (null: none, nothing to open). */
  workspaceId: string | null;
  /** Changes when the file may have changed (the canvas or the message showing it). */
  version: string;
}

/** A short line in place of a preview that cannot show. */
function PeekMessage({ text }: { text: string }) {
  return (
    <T variant="footnote" tone="faint">
      {text}
    </T>
  );
}

/** The picture itself, at its own proportions up to the frame's height. */
function PicturePeek({
  workspaceId,
  content,
  version,
}: {
  workspaceId: string;
  content: FileCanvas;
  version: string;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(null);
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 && (
        <WorkspaceImage
          key={`${content.path}:${version}`}
          workspaceId={workspaceId}
          path={content.path}
          alt={content.name}
          version={version}
          contentFit="contain"
          onSize={(size) => {
            if (size.width > 0 && size.height > 0) setRatio(size.width / size.height);
          }}
          fallback={<PeekMessage text={t('filesView.preview.failed')} />}
          style={[styles.picture, { height: fileImageHeight(width, ratio) }]}
        />
      )}
    </View>
  );
}

/** The first lines of a text: Markdown laid out, anything else in monospace; fading out. */
function TextPeek({
  workspaceId,
  content,
  version,
  markdown,
}: {
  workspaceId: string;
  content: FileCanvas;
  version: string;
  markdown: boolean;
}) {
  const { t } = useTranslation();
  const head = useFileHead(workspaceId, content.path, version, true);
  const [height, setHeight] = useState(0);
  const excerpt = useMemo(
    () =>
      head.data
        ? textExcerpt(head.data.text, {
            lines: markdown ? FILE_MARKDOWN_LINES : FILE_TEXT_LINES,
            cut: head.data.cut,
            markdown,
          })
        : null,
    [head.data, markdown],
  );

  if (head.isError) {
    return (
      <PeekMessage
        text={
          problemCode(head.error) === 'not_found'
            ? t('filesView.fileNotFound')
            : t('filesView.preview.failed')
        }
      />
    );
  }
  if (!excerpt) {
    return (
      <View style={[styles.well, styles.loading]}>
        <ActivityIndicator size="small" color={colors.textFaint} />
      </View>
    );
  }
  // Emptied since the bot presented it.
  if (!excerpt.text) return null;
  const faded = excerpt.more || height > FILE_PREVIEW_HEIGHT - WELL_PADDING * 2;
  return (
    <View style={styles.well}>
      <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
        {markdown ? (
          <Markdown text={excerpt.text} style={styles.markdown} />
        ) : (
          <T style={styles.mono}>{excerpt.text}</T>
        )}
      </View>
      {faded && (
        <LinearGradient colors={[`${well()}00`, well()]} style={styles.fade} pointerEvents="none" />
      )}
    </View>
  );
}

/**
 * A file or folder of the bot's workspace, presented in its answer (or pinned on Home): its
 * icon, name and size, a peek at it when cheap (a picture, the first lines of a text), then
 * open it in the app or share it. Tapping the card opens it too.
 */
export function FileBody({ content, workspaceId, version }: Props) {
  const { t, i18n } = useTranslation();
  const sharing = useShareEntry(workspaceId ?? '', null);
  const folder = content.type === 'directory';
  const preview = workspaceId ? filePreview(content) : null;
  const Icon = iconFor(content);

  const size = formatSize(
    content.size,
    {
      b: t('filesView.units.b'),
      kb: t('filesView.units.kb'),
      mb: t('filesView.units.mb'),
      gb: t('filesView.units.gb'),
      tb: t('filesView.units.tb'),
    },
    i18n.language,
  );
  const extension = fileExtension(content.name);
  const meta = folder
    ? t('board.canvas.file.folder')
    : extension
      ? `${size}  ·  ${extension}`
      : size;

  const open = () => {
    if (workspaceId) router.push(fileCanvasRoute(workspaceId, content));
  };

  const main = (
    <>
      {preview === 'image' && workspaceId ? (
        <PicturePeek workspaceId={workspaceId} content={content} version={version} />
      ) : null}
      <View style={styles.head}>
        <View style={styles.icon}>
          <Icon size={20} color={folder ? colors.text : colors.textMuted} strokeWidth={2} />
        </View>
        <View style={styles.titles}>
          <T variant="headline" numberOfLines={2}>
            {content.name}
          </T>
          <T variant="footnote" tone="muted" numberOfLines={1}>
            {meta}
          </T>
        </View>
      </View>
      {content.caption ? (
        <T variant="callout" tone="muted">
          {content.caption}
        </T>
      ) : null}
      {(preview === 'markdown' || preview === 'text') && workspaceId ? (
        <TextPeek
          workspaceId={workspaceId}
          content={content}
          version={version}
          markdown={preview === 'markdown'}
        />
      ) : null}
    </>
  );

  return (
    <View style={styles.root}>
      {workspaceId ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={[content.name, meta, content.caption].filter(Boolean).join(', ')}
          accessibilityHint={t(
            folder ? 'board.canvas.file.opensFolder' : 'board.canvas.file.opensFile',
          )}
          onPress={open}
          style={styles.main}
        >
          {main}
        </Touchable>
      ) : (
        <View style={styles.main}>{main}</View>
      )}
      {workspaceId ? (
        <View style={styles.buttons}>
          <Pill label={t('board.canvas.file.open')} variant="solid" onPress={open} />
          <Pill
            label={t(folder ? 'filesView.shareZip' : 'filesView.share')}
            icon={ShareIcon}
            loading={sharing.busy !== null}
            onPress={() => sharing.share({ path: content.path, type: content.type })}
          />
        </View>
      ) : null}
      {sharing.busy ? (
        <T variant="caption" tone="faint" numberOfLines={1} accessibilityLiveRegion="polite">
          {sharing.busy}
        </T>
      ) : null}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { gap: 14 },
    main: { gap: 12, borderRadius: 12 },
    picture: { width: '100%', borderRadius: 12, borderCurve: 'continuous' },
    head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    icon: {
      width: 42,
      height: 42,
      borderRadius: 12,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint.ink(0.06),
    },
    titles: { flex: 1, minWidth: 0, gap: 1 },
    well: {
      maxHeight: FILE_PREVIEW_HEIGHT,
      overflow: 'hidden',
      padding: WELL_PADDING,
      borderRadius: 12,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: well(),
    },
    loading: { height: 64, alignItems: 'center', justifyContent: 'center' },
    markdown: { fontSize: 14, lineHeight: 20 },
    mono: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, color: colors.text },
    fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 },
    buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  }),
);
