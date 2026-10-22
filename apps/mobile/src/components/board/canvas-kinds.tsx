import type { CanvasContent, CanvasSize } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Check, Plus, X } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  FRAME_HEIGHT,
  frameMayLoad,
  htmlCanvasPage,
  IMAGE_HEIGHT,
  NOTE_FOLD_HEIGHT,
  scoreText,
  statsColumns,
} from '../../lib/board';
import { useChecklist } from '../../lib/board-queries';
import { alertError } from '../../lib/options-menu';
import { isAndroid, isIOS } from '../../lib/platform';
import { colors, currentScheme, fieldType, themed, tint, type } from '../../theme';
import { Markdown } from '../markdown';
import { IconButton } from '../ui/button';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { CardBody } from './card-body';
import { FileBody } from './file-body';
import { GalleryBody } from './gallery-body';
import { WorkspaceImage } from './workspace-image';

type Content<K extends CanvasContent['kind']> = Extract<CanvasContent, { kind: K }>;

/** Background of a flat card, for fades that blend into it. */
/** The card's own color, for what fades into it (read at render: it follows the look). */
const cardBackground = () => (isAndroid ? colors.surfaceContainer : colors.surface);

// ---------------------------------------------------------------------------------------------
// Note: Markdown, with an optional picture; folded past a height that grows with the size.

export function NoteBody({
  content,
  workspaceId,
  size,
  version,
  title,
}: {
  content: Content<'note'>;
  workspaceId: string | null;
  size: CanvasSize;
  version: string;
  title: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [height, setHeight] = useState(0);
  const fold = NOTE_FOLD_HEIGHT[size];
  // A few lines of slack: folding away a single line is pointless.
  const folds = height > fold + 40;
  const folded = folds && !open;
  return (
    <View style={styles.note}>
      {content.image && workspaceId ? (
        <WorkspaceImage
          key={`${content.image}:${version}`}
          workspaceId={workspaceId}
          path={content.image}
          alt={title}
          version={version}
          style={[styles.noteImage, { height: IMAGE_HEIGHT[size] }]}
        />
      ) : null}
      {content.markdown.trim() ? (
        <View style={folded ? [styles.folded, { maxHeight: fold }] : undefined}>
          <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
            <Markdown text={content.markdown} style={styles.noteText} />
          </View>
          {folded && (
            <LinearGradient
              colors={[`${cardBackground()}00`, cardBackground()]}
              style={styles.fade}
              pointerEvents="none"
            />
          )}
        </View>
      ) : null}
      {folds && (
        <Touchable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((value) => !value)}
          hitSlop={8}
          style={styles.more}
        >
          <T variant="footnote" tone="muted" style={styles.moreText}>
            {open ? t('board.canvas.less') : t('board.canvas.more')}
          </T>
        </Touchable>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Score: two teams with their logos, the score and where the match stands.

function Logo({
  workspaceId,
  path,
  name,
  version,
}: {
  workspaceId: string | null;
  path?: string;
  name: string;
  version: string;
}) {
  const initial = (
    <View style={styles.initial}>
      <T variant="headline" tone="muted">
        {name.slice(0, 1).toUpperCase()}
      </T>
    </View>
  );
  if (!path || !workspaceId) return initial;
  return (
    <WorkspaceImage
      key={`${path}:${version}`}
      workspaceId={workspaceId}
      path={path}
      alt={name}
      version={version}
      contentFit="contain"
      style={styles.logo}
      fallback={initial}
    />
  );
}

export function ScoreBody({
  content,
  workspaceId,
  version,
}: {
  content: Content<'score'>;
  workspaceId: string | null;
  version: string;
}) {
  const team = (side: 'home' | 'away') => {
    const value = content[side];
    return (
      <View style={styles.team}>
        <Logo workspaceId={workspaceId} path={value.logo} name={value.name} version={version} />
        <T variant="footnote" numberOfLines={2} style={styles.teamName}>
          {value.name}
        </T>
      </View>
    );
  };
  return (
    <View style={styles.scoreRoot}>
      <View style={styles.scoreRow}>
        {team('home')}
        <View style={styles.scoreCenter}>
          <T
            style={styles.score}
            numberOfLines={1}
            adjustsFontSizeToFit
            accessibilityLabel={`${content.home.name} ${scoreText(content)} ${content.away.name}`}
          >
            {scoreText(content)}
          </T>
          {content.status ? (
            <View style={styles.status}>
              <T variant="caption" tone="muted" numberOfLines={1}>
                {content.status}
              </T>
            </View>
          ) : null}
        </View>
        {team('away')}
      </View>
      {content.detail ? (
        <T variant="caption" tone="faint" style={styles.center} numberOfLines={2}>
          {content.detail}
        </T>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Stats: a few figures in a grid.

const STATS_GAP = 12;

export function StatsBody({ content }: { content: Content<'stats'> }) {
  const [width, setWidth] = useState(0);
  const columns = statsColumns(content.items.length, width);
  // Fixed cell width: the last row's cells line up with the ones above.
  const cell = Math.floor((width - STATS_GAP * (columns - 1)) / columns);
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={styles.stats}>
      {width > 0 &&
        content.items.map((item) => (
          <View key={item.label} style={[styles.stat, { width: cell }]}>
            <T style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
              {item.value}
            </T>
            <T variant="caption" tone="muted" numberOfLines={1}>
              {item.label}
            </T>
            {item.hint ? (
              <T variant="caption" tone="faint" numberOfLines={2}>
                {item.hint}
              </T>
            ) : null}
          </View>
        ))}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Checklist: tick, add, remove (on Home); as it was, in a message.

const BOX = 22;

function Box({ done }: { done: boolean }) {
  return (
    <View style={[styles.box, done && styles.boxDone]}>
      {done && <Check size={14} color={colors.accentInk} strokeWidth={3} />}
    </View>
  );
}

/** A list shown in a message: read-only (the bot keeps lists to edit on Home). */
export function ChecklistView({ content }: { content: Content<'checklist'> }) {
  const { t } = useTranslation();
  if (content.items.length === 0) {
    return (
      <T variant="footnote" tone="faint" style={styles.emptyList}>
        {t('board.canvas.emptyList')}
      </T>
    );
  }
  return (
    <View>
      {content.items.map((item) => (
        <View
          key={item.id}
          accessible
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.done, disabled: true }}
          accessibilityLabel={item.text}
          style={styles.itemStill}
        >
          <Box done={item.done} />
          <T variant="callout" style={[styles.itemText, item.done && styles.itemDone]}>
            {item.text}
          </T>
        </View>
      ))}
    </View>
  );
}

export function ChecklistBody({
  canvasId,
  content,
}: {
  canvasId: string;
  content: Content<'checklist'>;
}) {
  const { t } = useTranslation();
  const { toggle, add, remove } = useChecklist(canvasId);
  const [text, setText] = useState('');

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    add.mutate(value, {
      onError: () => {
        setText(value);
        alertError(t('common.actionFailed'));
      },
    });
  };

  return (
    <View>
      {content.items.length === 0 && (
        <T variant="footnote" tone="faint" style={styles.emptyList}>
          {t('board.canvas.emptyList')}
        </T>
      )}
      {content.items.map((item) => (
        <View key={item.id} style={styles.item}>
          <Touchable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: item.done }}
            accessibilityLabel={item.text}
            onPress={() => {
              void Haptics.selectionAsync();
              toggle.mutate({ itemId: item.id, done: !item.done });
            }}
            style={styles.itemPress}
          >
            <Box done={item.done} />
            <T variant="callout" style={[styles.itemText, item.done && styles.itemDone]}>
              {item.text}
            </T>
          </Touchable>
          <IconButton
            icon={X}
            size={34}
            color={colors.textFaint}
            label={t('board.canvas.removeItem', { text: item.text })}
            onPress={() => remove.mutate(item.id)}
          />
        </View>
      ))}
      <View style={styles.addRow}>
        <View style={styles.addIcon}>
          <Plus size={18} color={colors.textFaint} />
        </View>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          submitBehavior="submit"
          returnKeyType="done"
          maxLength={200}
          placeholder={t('board.canvas.addItem')}
          placeholderTextColor={colors.textFaint}
          selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
          cursorColor={colors.accentStrong}
          selectionHandleColor={colors.accentStrong}
          keyboardAppearance={currentScheme()}
          accessibilityLabel={t('board.canvas.addItem')}
          style={styles.addInput}
        />
        {text.trim() ? (
          <IconButton
            icon={Check}
            size={34}
            color={colors.text}
            label={t('board.canvas.add')}
            onPress={submit}
          />
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// HTML: the bot's own page, without JavaScript, network or navigation.

export function HtmlBody({ content, size }: { content: Content<'html'>; size: CanvasSize }) {
  return (
    <View style={[styles.frame, { height: FRAME_HEIGHT[size] }]}>
      <WebView
        source={{ html: htmlCanvasPage(content.html) }}
        // Everything goes through the check below: nothing is handed to the system browser.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(request) => frameMayLoad(request.url)}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        geolocationEnabled={false}
        cacheEnabled={false}
        incognito
        allowsLinkPreview={false}
        allowsInlineMediaPlayback={false}
        mediaPlaybackRequiresUserAction
        dataDetectorTypes="none"
        webviewDebuggingEnabled={false}
        nestedScrollEnabled
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        style={styles.web}
        containerStyle={styles.web}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Any kind, without the Home card around it (also what a bot shows inside its answer).

export interface CanvasBodyProps {
  content: CanvasContent;
  /** The bot's workspace, where its pictures and the files it presents are. */
  workspaceId: string | null;
  size: CanvasSize;
  /** Changes when the pictures may have changed (the canvas was updated). */
  version: string;
  /** Name of a note's picture (the canvas title, or the bot). */
  title: string;
  /** A canvas on Home: its list can be ticked and edited. In a message, lists are read-only. */
  canvasId?: string;
  /** In a message: the card button pressed (null: not yet). Left out on Home. */
  pressed?: string | null;
  /** A card's button that answers the bot: resolves true once the bot has the answer. */
  onAnswer(index: number): Promise<boolean>;
}

export function CanvasBody({
  content,
  workspaceId,
  size,
  version,
  title,
  canvasId,
  pressed,
  onAnswer,
}: CanvasBodyProps) {
  switch (content.kind) {
    case 'note':
      return (
        <NoteBody
          content={content}
          workspaceId={workspaceId}
          size={size}
          version={version}
          title={title}
        />
      );
    case 'score':
      return <ScoreBody content={content} workspaceId={workspaceId} version={version} />;
    case 'stats':
      return <StatsBody content={content} />;
    case 'checklist':
      return canvasId ? (
        <ChecklistBody canvasId={canvasId} content={content} />
      ) : (
        <ChecklistView content={content} />
      );
    case 'html':
      return <HtmlBody content={content} size={size} />;
    case 'card':
      return (
        <CardBody
          content={content}
          workspaceId={workspaceId}
          version={version}
          pressed={pressed}
          onAnswer={onAnswer}
        />
      );
    case 'gallery':
      return <GalleryBody content={content} workspaceId={workspaceId} version={version} />;
    case 'file':
      return <FileBody content={content} workspaceId={workspaceId} version={version} />;
  }
}

const styles = themed(() =>
  StyleSheet.create({
    // Note
    note: { gap: 12 },
    noteImage: { width: '100%', borderRadius: 12, borderCurve: 'continuous' },
    noteText: { fontSize: 14.5, lineHeight: 21 },
    folded: { overflow: 'hidden' },
    fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 48 },
    more: { alignSelf: 'flex-start', marginTop: -4 },
    moreText: { fontWeight: '600' },
    // Score
    scoreRoot: { gap: 10 },
    scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    team: { flex: 1, minWidth: 0, alignItems: 'center', gap: 8 },
    teamName: { fontWeight: '600', textAlign: 'center' },
    logo: { width: 52, height: 52, backgroundColor: 'transparent' },
    initial: {
      width: 52,
      height: 52,
      borderRadius: 26,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint.ink(0.06),
    },
    scoreCenter: { alignItems: 'center', gap: 6, maxWidth: '40%' },
    score: {
      fontSize: 36,
      lineHeight: 42,
      fontWeight: '700',
      letterSpacing: -0.6,
      color: colors.text,
      fontVariant: ['tabular-nums'],
    },
    status: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 9999,
      backgroundColor: tint.ink(0.06),
    },
    center: { textAlign: 'center' },
    // Stats
    stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: STATS_GAP, rowGap: 14 },
    stat: { minWidth: 0, gap: 1 },
    statValue: {
      fontSize: 24,
      lineHeight: 30,
      fontWeight: '700',
      letterSpacing: -0.3,
      color: colors.text,
      fontVariant: ['tabular-nums'],
    },
    // Checklist
    emptyList: { paddingVertical: 6 },
    item: { flexDirection: 'row', alignItems: 'center', minHeight: 40, marginRight: -8 },
    itemPress: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
      borderRadius: 8,
    },
    box: {
      width: BOX,
      height: BOX,
      borderRadius: BOX / 2,
      borderWidth: 1.5,
      borderColor: tint.ink(0.28),
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxDone: { backgroundColor: colors.accentStrong, borderColor: colors.accentStrong },
    itemStill: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
    itemText: { flex: 1, color: colors.text },
    itemDone: { color: colors.textFaint, textDecorationLine: 'line-through' },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40, marginRight: -8 },
    addIcon: { width: BOX, alignItems: 'center' },
    addInput: {
      ...fieldType(type.callout),
      flex: 1,
      color: colors.text,
      paddingVertical: isIOS ? 8 : 4,
    },
    // HTML
    frame: { borderRadius: 10, overflow: 'hidden' },
    web: { flex: 1, backgroundColor: 'transparent' },
  }),
);
