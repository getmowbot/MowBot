import type { Bot, FeedItem, Task, TaskStatus } from '@mowbot/contract';
import { router, Stack } from 'expo-router';
import { ArrowRight, Eraser, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { BotAvatar } from '../../../../components/bot-avatar';
import { openChat } from '../../../../components/bot-row';
import { Markdown } from '../../../../components/markdown';
import { reveal } from '../../../../components/reveal';
import { Section, TabScroll } from '../../../../components/tab-scroll';
import { Button, IconButton } from '../../../../components/ui/button';
import { Segmented } from '../../../../components/ui/segmented';
import { Surface } from '../../../../components/ui/surface';
import { T } from '../../../../components/ui/text';
import { Touchable } from '../../../../components/ui/touchable';
import { markdownToPlain } from '../../../../lib/markdown';
import { messageText } from '../../../../lib/message-cache';
import { alertError, confirm } from '../../../../lib/options-menu';
import { isIOS } from '../../../../lib/platform';
import {
  botsById,
  useBots,
  useCancelTask,
  useClearActivity,
  useFeed,
  useTasks,
} from '../../../../lib/queries';
import { timeAgo } from '../../../../lib/time';
import { colors } from '../../../../theme';

type Tab = 'tasks' | 'exchanges';

const COLUMNS: { key: 'doing' | 'todo' | 'blocked' | 'done'; statuses: TaskStatus[] }[] = [
  { key: 'doing', statuses: ['doing'] },
  { key: 'todo', statuses: ['todo'] },
  { key: 'blocked', statuses: ['blocked'] },
  { key: 'done', statuses: ['done', 'cancelled'] },
];

function TaskCard({ task, byId }: { task: Task; byId: Map<string, Bot> }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const cancel = useCancelTask();
  const assignee = byId.get(task.assigneeBotId);
  const creator = task.creatorBotId ? byId.get(task.creatorBotId) : undefined;
  const finished = task.status === 'done' || task.status === 'cancelled';

  const confirmCancel = () =>
    Alert.alert(t('tasks.cancelConfirm', { title: task.title }), undefined, [
      { text: t('tasks.keep'), style: 'cancel' },
      {
        text: t('tasks.cancel'),
        style: 'destructive',
        onPress: () => cancel.mutate(task, { onError: () => alertError(t('common.actionFailed')) }),
      },
    ]);

  return (
    <Surface style={styles.card}>
      <Touchable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={styles.cardBody}
      >
        <T
          variant="headline"
          style={task.status === 'cancelled' ? styles.cancelled : undefined}
          numberOfLines={open ? undefined : 2}
        >
          {task.title}
        </T>
        <View style={styles.meta}>
          {assignee && <BotAvatar seed={assignee.avatarSeed} size={18} still />}
          <T variant="caption" tone="muted" numberOfLines={1} style={styles.shrink}>
            {t('tasks.meta', {
              assignee: assignee?.name ?? t('common.deletedBot'),
              creator: creator?.name ?? t('common.you'),
              time: timeAgo(task.updatedAt, t, i18n.language),
            })}
          </T>
        </View>
        {open && task.details ? (
          <T variant="footnote" tone="muted" selectable>
            {task.details}
          </T>
        ) : null}
        {task.result ? (
          <T variant="footnote" numberOfLines={open ? undefined : 3} selectable={open}>
            {task.result}
          </T>
        ) : null}
      </Touchable>
      {open && !finished && (
        <Button
          label={t('tasks.cancel')}
          variant="secondary"
          loading={cancel.isPending}
          onPress={confirmCancel}
          style={styles.cancel}
        />
      )}
    </Surface>
  );
}

function Tasks({ tasks, byId }: { tasks: Task[]; byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  if (tasks.length === 0) {
    return (
      <View style={styles.list}>
        <T variant="footnote" tone="faint" style={styles.indent}>
          {t('tasks.empty')}
        </T>
        <Button
          label={t('orgAdmin.task.assign')}
          icon={Plus}
          variant="secondary"
          onPress={() => router.push('/task/new')}
        />
      </View>
    );
  }
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return COLUMNS.map((column) => {
    const items = recent.filter((task) => column.statuses.includes(task.status));
    if (items.length === 0) return null;
    return (
      <Section
        key={column.key}
        title={t(`tasks.column.${column.key}`)}
        accessory={
          <T variant="caption" tone="faint">
            {items.length}
          </T>
        }
      >
        <View style={styles.list}>
          {items.map((task) => (
            <TaskCard key={task.id} task={task} byId={byId} />
          ))}
        </View>
      </Section>
    );
  });
}

function FeedRow({ item, byId }: { item: FeedItem; byId: Map<string, Bot> }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const from = item.fromBotId ? byId.get(item.fromBotId) : undefined;
  const to = byId.get(item.toBotId);
  const fromName = from?.name ?? item.fromName ?? t('common.deletedBot');
  const toName = to?.name ?? t('common.deletedBot');
  const text = messageText(item);
  return (
    <Animated.View entering={reveal()} style={styles.feedRow}>
      <View style={styles.pair}>
        <BotAvatar seed={from?.avatarSeed ?? fromName} size={26} still />
        <ArrowRight size={12} color={colors.textFaint} />
        <BotAvatar seed={to?.avatarSeed ?? toName} size={26} still />
      </View>
      <View style={styles.feedBody}>
        <T
          variant="caption"
          tone="muted"
          numberOfLines={1}
          onPress={to ? () => openChat(to) : undefined}
        >
          {t('tasks.feedTo', { from: fromName, to: toName })} · {t(`chat.kind.${item.kind}`)} ·{' '}
          {timeAgo(item.createdAt, t, i18n.language)}
        </T>
        <Touchable onPress={() => setOpen((value) => !value)} style={styles.feedText}>
          {open ? (
            <Markdown text={text} style={styles.feedMarkdown} />
          ) : (
            <T variant="callout" numberOfLines={5} style={styles.feedPlain}>
              {markdownToPlain(text)}
            </T>
          )}
        </Touchable>
      </View>
    </Animated.View>
  );
}

function Exchanges({ byId }: { byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  const feed = useFeed();
  if (feed.isPending) return <ActivityIndicator color={colors.textMuted} />;
  const items = feed.data ?? [];
  if (items.length === 0) {
    return (
      <T variant="footnote" tone="faint" style={styles.indent}>
        {t('tasks.feedEmpty')}
      </T>
    );
  }
  return (
    <View style={styles.feed}>
      {items.map((item) => (
        <FeedRow key={item.id} item={item} byId={byId} />
      ))}
      {feed.hasNextPage && (
        <Button
          label={t('tasks.loadMore')}
          variant="secondary"
          loading={feed.isFetchingNextPage}
          onPress={() => void feed.fetchNextPage()}
        />
      )}
    </View>
  );
}

/** What the bots do together: the tasks they hand each other, and what they write. */
export default function ActivityScreen() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('tasks');
  const bots = useBots();
  const tasks = useTasks();
  const feed = useFeed();
  const clear = useClearActivity();
  const byId = botsById(bots.data);
  const headerSize = isIOS ? 36 : 40;

  // Finished tasks and the bots' exchanges go; ongoing tasks and conversations stay.
  const askClear = async () => {
    const ok = await confirm(t('tasks.clearConfirm'), t('tasks.clearHint'), {
      label: t('tasks.clearAction'),
      destructive: true,
    });
    if (!ok) return;
    clear.mutate(undefined, { onError: () => alertError(t('common.actionFailed')) });
  };

  return (
    <TabScroll onRefresh={() => Promise.all([bots.refetch(), tasks.refetch(), feed.refetch()])}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={styles.headerActions}>
              <IconButton
                icon={Eraser}
                label={t('tasks.clear')}
                onPress={() => void askClear()}
                size={headerSize}
              />
              <IconButton
                icon={Plus}
                label={t('orgAdmin.task.title')}
                onPress={() => router.push('/task/new')}
                size={headerSize}
              />
            </View>
          ),
        }}
      />
      <View style={styles.head}>
        <T variant="footnote" tone="muted" style={styles.indent}>
          {t('tasks.intro')}
        </T>
        <Segmented<Tab>
          label={t('tabs.activity')}
          options={[
            { value: 'tasks', label: t('tasks.segment') },
            { value: 'exchanges', label: t('tasks.exchanges') },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      {tab === 'tasks' ? (
        tasks.isPending ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <Tasks tasks={tasks.data ?? []} byId={byId} />
        )
      ) : (
        <Exchanges byId={byId} />
      )}
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  head: { gap: 14 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  indent: { paddingHorizontal: 4 },
  list: { gap: 10 },
  card: { padding: 6, gap: 4 },
  cardBody: { padding: 8, gap: 8, borderRadius: 12 },
  cancelled: { textDecorationLine: 'line-through', opacity: 0.6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  cancel: { alignSelf: 'flex-start', minHeight: 40, margin: 8, marginTop: 0 },
  feed: { gap: 20 },
  feedRow: { flexDirection: 'row', gap: 12 },
  pair: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingTop: 2 },
  feedBody: { flex: 1, minWidth: 0, gap: 4 },
  feedText: { borderRadius: 8 },
  feedPlain: { color: 'rgba(238, 241, 246, 0.85)' },
  feedMarkdown: { fontSize: 14.5, lineHeight: 21 },
});
