import type { Bot, Canvas } from '@mowbot/contract';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Ellipsis,
  Eye,
  EyeOff,
  Scaling,
  Trash2,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { CANVAS_SIZES, checklistProgress, foldedSummary } from '../../lib/board';
import { useCanvasActions } from '../../lib/board-queries';
import { alertError, confirm, type MenuOption, openOptions } from '../../lib/options-menu';
import { timeAgo } from '../../lib/time';
import { colors } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { useBotMood } from '../bot-row';
import { IconButton } from '../ui/button';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { CanvasBody } from './canvas-kinds';

/** The bot that pinned the card, alive (its mood follows what it is doing). */
function Author({ bot }: { bot: Bot }) {
  const mood = useBotMood(bot);
  return <BotAvatar seed={bot.avatarSeed} size={30} mood={mood} />;
}

interface Props {
  canvas: Canvas;
  bot: Bot | undefined;
  /** First / last card on screen: it cannot move further that way. */
  first: boolean;
  last: boolean;
  onMove(direction: -1 | 1): void;
}

/** A card a bot pinned on Home, drawn natively per kind, with its ⋯ menu. */
export function CanvasCard({ canvas, bot, first, last, onMove }: Props) {
  const { t, i18n } = useTranslation();
  const { update, remove, press } = useCanvasActions();
  const { content } = canvas;
  const workspaceId = bot?.workspaceId ?? null;
  const progress = checklistProgress(content);
  const botName = bot?.name ?? t('board.canvas.someBot');
  const failed = () => alertError(t('common.actionFailed'));

  const change = (body: { size?: Canvas['size']; hidden?: boolean; collapsed?: boolean }) =>
    update.mutate({ id: canvas.id, body }, { onError: failed });
  const answer = (button: number) =>
    press.mutateAsync({ id: canvas.id, button }).then(
      () => true,
      () => {
        failed();
        return false;
      },
    );
  const folded = canvas.collapsed;
  const summary = folded ? foldedSummary(content, t) : null;

  const openMenu = () => {
    const options: MenuOption[] = [];
    if (!first) {
      options.push({ label: t('board.canvas.moveUp'), icon: ArrowUp, onPress: () => onMove(-1) });
    }
    if (!last) {
      options.push({
        label: t('board.canvas.moveDown'),
        icon: ArrowDown,
        onPress: () => onMove(1),
      });
    }
    for (const size of CANVAS_SIZES) {
      if (size === canvas.size) continue;
      options.push({
        label: t(`board.canvas.sizeTo.${size}`),
        icon: Scaling,
        onPress: () => change({ size }),
      });
    }
    options.push({
      label: canvas.hidden ? t('board.canvas.show') : t('board.canvas.hide'),
      icon: canvas.hidden ? Eye : EyeOff,
      onPress: () => change({ hidden: !canvas.hidden }),
    });
    options.push({
      label: t('board.canvas.delete'),
      icon: Trash2,
      destructive: true,
      onPress: () =>
        void confirm(
          t('board.canvas.deleteTitle', { title: canvas.title }),
          t('board.canvas.deleteBody', { bot: botName }),
          { label: t('common.delete'), destructive: true },
        ).then((ok) => ok && remove.mutate(canvas.id, { onError: failed })),
    });
    openOptions({
      title: canvas.title,
      message: t('board.canvas.currentSize', { size: t(`board.canvas.sizes.${canvas.size}`) }),
      options,
    });
  };

  return (
    <Surface style={[styles.card, folded && styles.folded]}>
      <View style={styles.header}>
        {bot ? <Author bot={bot} /> : <BotAvatar seed={canvas.botId} size={30} still />}
        <Touchable
          accessibilityRole="button"
          accessibilityState={{ expanded: !folded }}
          accessibilityHint={folded ? t('board.canvas.unfold') : t('board.canvas.fold')}
          onPress={() => change({ collapsed: !folded })}
          style={styles.headText}
        >
          <View style={styles.titleRow}>
            <T variant="headline" numberOfLines={2} style={styles.shrink}>
              {canvas.title}
            </T>
            <ChevronDown
              size={16}
              color={colors.textFaint}
              style={folded ? styles.chevronFolded : undefined}
            />
          </View>
          {summary ? (
            <T variant="footnote" tone="muted" numberOfLines={1}>
              {summary}
            </T>
          ) : null}
          <View style={styles.meta}>
            {canvas.hidden && (
              <EyeOff
                size={12}
                color={colors.textFaint}
                accessibilityLabel={t('board.canvas.hidden')}
              />
            )}
            <T variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
              {t('board.canvas.meta', {
                bot: botName,
                time: timeAgo(canvas.updatedAt, t, i18n.language),
              })}
            </T>
          </View>
        </Touchable>
        {progress && (
          <T
            variant="caption"
            tone="faint"
            style={styles.progress}
            accessibilityLabel={t('board.canvas.progress', progress)}
          >
            {progress.done}/{progress.total}
          </T>
        )}
        <IconButton
          icon={Ellipsis}
          size={34}
          color={colors.textMuted}
          label={t('board.canvas.menu', { title: canvas.title })}
          onPress={openMenu}
        />
      </View>

      {folded ? null : (
        <View style={canvas.hidden ? styles.dimmed : undefined}>
          <CanvasBody
            content={content}
            workspaceId={workspaceId}
            size={canvas.size}
            version={canvas.updatedAt}
            title={canvas.title}
            canvasId={canvas.id}
            onAnswer={answer}
          />
        </View>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, paddingTop: 12, gap: 14 },
  // The ⋯ button's glyph lines up with the checklist's remove buttons (both pulled by 8).
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: -8 },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  folded: { paddingBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chevronFolded: { transform: [{ rotate: '-90deg' }] },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  shrink: { flexShrink: 1 },
  progress: { fontVariant: ['tabular-nums'] },
  dimmed: { opacity: 0.5 },
});
