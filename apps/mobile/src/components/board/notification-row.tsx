import type { Bot, Notification } from '@mowbot/contract';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { timeAgo } from '../../lib/time';
import { colors, themed } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { ROW_INSET } from '../ui/rows';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

const DOT = 8;
const GAP = 12;
/** ListCard divider inset for notification rows (past the unread dot, under the text). */
export const NOTIFICATION_INSET = ROW_INSET + DOT + GAP;

const DOT_COLOR: Record<Notification['priority'], string> = themed(() => ({
  urgent: colors.danger,
  normal: colors.accentStrong,
  digest: colors.textFaint,
}));

interface Props {
  notification: Notification;
  bot: Bot | undefined;
  /** Lines of the body before it is cut (all of it when left out). */
  bodyLines?: number;
  /** Tapping an unread notification marks it read. */
  onRead?(notification: Notification): void;
}

/** A notification in a ListCard: unread dot (red when urgent), title, body, who and when. */
export function NotificationRow({ notification, bot, bodyLines, onRead }: Props) {
  const { t, i18n } = useTranslation();
  const unread = !notification.readAt;
  const urgent = notification.priority === 'urgent';
  const content = (
    <>
      <View style={styles.dotColumn}>
        {unread && (
          <View style={[styles.dot, { backgroundColor: DOT_COLOR[notification.priority] }]} />
        )}
      </View>
      <View style={styles.text}>
        <T variant="callout" style={unread ? styles.unread : undefined}>
          {urgent ? `${t('board.notifications.urgent')} · ` : ''}
          {notification.title}
        </T>
        {notification.body ? (
          <T variant="footnote" tone="muted" numberOfLines={bodyLines} selectable={!bodyLines}>
            {notification.body}
          </T>
        ) : null}
        <View style={styles.meta}>
          {bot && <BotAvatar seed={bot.avatarSeed} size={14} still />}
          <T variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
            {bot?.name ?? t('board.notifications.hub')} ·{' '}
            {timeAgo(notification.createdAt, t, i18n.language)}
          </T>
        </View>
      </View>
    </>
  );
  if (!unread || !onRead) return <View style={styles.row}>{content}</View>;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityHint={t('board.notifications.markRead')}
      onPress={() => onRead(notification)}
      style={styles.row}
    >
      {content}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: GAP,
    paddingHorizontal: ROW_INSET,
    paddingVertical: 12,
    overflow: 'hidden',
  },
  dotColumn: { width: DOT, paddingTop: 7 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  text: { flex: 1, minWidth: 0, gap: 3 },
  unread: { fontWeight: '600' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  shrink: { flexShrink: 1 },
});
