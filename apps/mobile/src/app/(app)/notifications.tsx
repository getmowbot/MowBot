import { Eraser } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NOTIFICATION_INSET, NotificationRow } from '../../components/board/notification-row';
import { ListCard } from '../../components/list-card';
import { Screen } from '../../components/screen';
import { Section } from '../../components/tab-scroll';
import { Button, IconButton } from '../../components/ui/button';
import { T } from '../../components/ui/text';
import { Touchable } from '../../components/ui/touchable';
import { groupByDay } from '../../lib/board';
import {
  useClearNotifications,
  useMarkNotificationsRead,
  useNotifications,
} from '../../lib/board-queries';
import { alertError, confirm } from '../../lib/options-menu';
import { botsById, useBots } from '../../lib/queries';
import { colors } from '../../theme';

/**
 * Every notification (the latest 100), by day; tapping an unread one marks it read. The header
 * reads them all, or clears them all.
 */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const bots = useBots();
  const read = useMarkNotificationsRead();
  const clear = useClearNotifications();
  const byId = botsById(bots.data);
  const items = notifications.data?.items ?? [];
  const unread = notifications.data?.unread ?? 0;
  const anyUnread = items.some((n) => !n.readAt);

  const askClear = async () => {
    const ok = await confirm(
      t('board.notifications.clearConfirm'),
      t('board.notifications.clearHint'),
      { label: t('board.notifications.clearAction'), destructive: true },
    );
    if (!ok) return;
    clear.mutate(undefined, { onError: () => alertError(t('common.actionFailed')) });
  };

  const headerRight =
    items.length > 0
      ? () => (
          <View style={styles.headerActions}>
            {anyUnread && (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={t('board.notifications.markAllRead')}
                onPress={() => read.mutate(undefined)}
                hitSlop={10}
                style={styles.headerButton}
              >
                <T variant="callout" style={styles.headerText}>
                  {t('board.notifications.readAll')}
                </T>
              </Touchable>
            )}
            <IconButton
              icon={Eraser}
              label={t('board.notifications.clearAll')}
              onPress={() => void askClear()}
            />
          </View>
        )
      : undefined;

  let body: ReactNode;
  if (notifications.isPending) {
    body = <ActivityIndicator color={colors.textMuted} style={styles.loading} />;
  } else if (notifications.isError) {
    body = (
      <View style={styles.center}>
        <T tone="muted">{t('errors.generic')}</T>
        <Button
          label={t('common.retry')}
          variant="secondary"
          onPress={() => void notifications.refetch()}
        />
      </View>
    );
  } else if (items.length === 0) {
    body = (
      <T tone="faint" style={styles.none}>
        {t('board.notifications.none')}
      </T>
    );
  } else {
    body = (
      <>
        {unread > 0 && (
          <T variant="footnote" tone="muted" style={styles.indent}>
            {t('board.notifications.unread', { count: unread })}
          </T>
        )}
        {groupByDay(items).map((group) => (
          <Section key={group.day} title={t(`board.notifications.${group.day}`)}>
            <ListCard inset={NOTIFICATION_INSET}>
              {group.items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  bot={notification.botId ? byId.get(notification.botId) : undefined}
                  onRead={(n) => read.mutate([n.id])}
                />
              ))}
            </ListCard>
          </Section>
        ))}
      </>
    );
  }

  return (
    <Screen
      title={t('board.notifications.title')}
      headerRight={headerRight}
      onRefresh={() => notifications.refetch()}
    >
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  center: { alignItems: 'center', gap: 16, marginTop: 32 },
  none: { textAlign: 'center', marginTop: 32 },
  indent: { paddingHorizontal: 4, marginBottom: -12 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerButton: { paddingHorizontal: 4 },
  headerText: { fontWeight: '600', color: colors.text },
});
