import type { Bot, Canvas } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import { ArrowUp, Pause, Play } from 'lucide-react-native';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { CanvasCard } from '../../../../components/board/canvas-card';
import { leave, settle } from '../../../../components/board/motion';
import { Pill } from '../../../../components/board/pill';
import { BotAvatar } from '../../../../components/bot-avatar';
import { useBotMood } from '../../../../components/bot-row';
import { QuestionCard } from '../../../../components/questions';
import { reveal } from '../../../../components/reveal';
import { Section } from '../../../../components/tab-scroll';
import { Button } from '../../../../components/ui/button';
import { ShimmerText } from '../../../../components/ui/shimmer-text';
import { Surface } from '../../../../components/ui/surface';
import { T } from '../../../../components/ui/text';
import { Touchable } from '../../../../components/ui/touchable';
import {
  dayPeriod,
  firstName,
  moveCanvas,
  shownCanvases,
  workingBots,
} from '../../../../lib/board';
import {
  useCanvasActions,
  useCanvases,
  useQuestions,
  useSystem,
  useUpdateSystem,
} from '../../../../lib/board-queries';
import { alertError, confirm } from '../../../../lib/options-menu';
import { isAndroid, isIOS } from '../../../../lib/platform';
import { botsById, keys, useBots, useMe, useSendMessage } from '../../../../lib/queries';
import { colors, shape, spacing, type } from '../../../../theme';

const HOME_QUERIES = [
  keys.me,
  keys.bots,
  keys.system,
  keys.questions,
  keys.canvases,
  // Which cards are live.
  keys.automations,
];

/** The hour, kept current (the greeting turns to "good evening" while the app is open). */
function useHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return hour;
}

/**
 * The tab's scroll view: like TabScroll (inset under the large title and above the tab bar,
 * pull to refresh) but keeping the focused field above the keyboard (ask the Chef, answer a
 * question, add to a checklist).
 */
function HomeScroll({
  children,
  onRefresh,
}: {
  children: ReactNode;
  onRefresh(): Promise<unknown>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <KeyboardAwareScrollView
      style={styles.root}
      bottomOffset={24}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={colors.textMuted}
          colors={[colors.accentInk]}
          progressBackgroundColor={colors.accentStrong}
        />
      }
    >
      {children}
    </KeyboardAwareScrollView>
  );
}

function LiveAvatar({ bot, size }: { bot: Bot; size: number }) {
  const mood = useBotMood(bot);
  return <BotAvatar seed={bot.avatarSeed} size={size} mood={mood} />;
}

/** Who is at work right now (up to three, huddled), or the Chef when everyone is free. */
function Crew({ working, chef }: { working: Bot[]; chef: Bot | undefined }) {
  const shown = working.slice(0, 3);
  if (shown.length === 0) return chef ? <LiveAvatar bot={chef} size={44} /> : null;
  return (
    <View style={styles.crew}>
      {shown.map((bot, index) => (
        <View key={bot.id} style={index > 0 ? styles.crewOverlap : undefined}>
          <LiveAvatar bot={bot} size={44} />
        </View>
      ))}
    </View>
  );
}

/** How many bots are working, and the global pause (confirmed) / resume. */
function StatusCard({ bots, chef }: { bots: Bot[]; chef: Bot | undefined }) {
  const { t } = useTranslation();
  const system = useSystem();
  const update = useUpdateSystem();
  const working = workingBots(bots);
  const paused = system.data?.paused ?? false;
  const failed = () => alertError(t('common.actionFailed'));

  const pause = async () => {
    const ok = await confirm(t('board.pauseTitle'), t('board.pauseConfirm'), {
      label: t('board.pause'),
      destructive: true,
    });
    if (!ok) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    update.mutate({ paused: true }, { onError: failed });
  };
  const resume = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    update.mutate({ paused: false }, { onError: failed });
  };

  if (paused) {
    return (
      <Surface style={styles.paused}>
        <View style={styles.pausedRow}>
          {chef ? (
            <BotAvatar seed={chef.avatarSeed} size={44} mood="sleeping" />
          ) : (
            <Pause size={20} color={colors.text} />
          )}
          <T variant="footnote" style={styles.flex}>
            {t('board.paused')}
          </T>
        </View>
        <Button label={t('board.resume')} icon={Play} loading={update.isPending} onPress={resume} />
      </Surface>
    );
  }

  return (
    <Surface style={styles.status}>
      <Crew working={working} chef={chef} />
      <View style={styles.flex}>
        {working.length > 0 ? (
          <ShimmerText numberOfLines={2} color={colors.text} style={type.callout}>
            {t('board.working', { count: working.length })}
          </ShimmerText>
        ) : (
          <T variant="callout" tone="muted">
            {t('board.allIdle')}
          </T>
        )}
      </View>
      {system.isSuccess && (
        <Pill
          icon={Pause}
          label={t('board.pause')}
          loading={update.isPending}
          onPress={() => void pause()}
        />
      )}
    </Surface>
  );
}

/** Questions bots asked and wait an answer for, newest first. */
function Questions({ byId }: { byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  const asked = useQuestions().data ?? [];
  if (asked.length === 0) return null;
  return (
    <Section title={t('board.questions.title', { count: asked.length })}>
      <View style={styles.stack}>
        {asked.map((question) => (
          <Animated.View key={question.id} entering={reveal()} exiting={leave} layout={settle}>
            <QuestionCard question={question} bot={byId.get(question.botId)} />
          </Animated.View>
        ))}
      </View>
    </Section>
  );
}

const SEND = isAndroid ? 40 : 36;

/** A quick message to the Chef, then its conversation opens. */
function AskChef({ chef }: { chef: Bot }) {
  const { t } = useTranslation();
  const mood = useBotMood(chef);
  const send = useSendMessage(chef.id);
  const [text, setText] = useState('');
  const empty = text.trim().length === 0;

  const submit = () => {
    const value = text.trim();
    if (!value || send.isPending) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    send.mutate(
      { text: value },
      {
        onSuccess: () => {
          setText('');
          router.push(`/chat/${chef.id}`);
        },
        onError: () => alertError(t('errors.messageNotSent')),
      },
    );
  };

  return (
    <Surface style={styles.ask}>
      <BotAvatar seed={chef.avatarSeed} size={30} mood={mood} />
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        submitBehavior="blurAndSubmit"
        returnKeyType="send"
        maxLength={20_000}
        placeholder={t('board.askChef')}
        placeholderTextColor={colors.textFaint}
        selectionColor={isIOS ? colors.accentStrong : 'rgba(255, 255, 255, 0.35)'}
        cursorColor={colors.accentStrong}
        selectionHandleColor={colors.accentStrong}
        keyboardAppearance="dark"
        accessibilityLabel={t('board.askChef')}
        style={styles.askInput}
      />
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={t('board.askChefSend')}
        accessibilityState={{ disabled: empty, busy: send.isPending }}
        onPress={submit}
        disabled={empty || send.isPending}
        onAccent
        style={[styles.send, empty && styles.sendIdle]}
      >
        {send.isPending ? (
          <ActivityIndicator size="small" color={colors.accentInk} />
        ) : (
          <ArrowUp size={19} color={colors.accentInk} strokeWidth={2.4} />
        )}
      </Touchable>
    </Surface>
  );
}

function LoadFailed({ onRetry }: { onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.failed}>
      <T variant="footnote" tone="faint" style={styles.flex}>
        {t('board.loadFailed')}
      </T>
      <Pill variant="ghost" label={t('common.retry')} onPress={onRetry} />
    </View>
  );
}

/** What the bots pinned, one column, in the user's order; removed cards behind a toggle. */
function Canvases({ byId }: { byId: Map<string, Bot> }) {
  const { t } = useTranslation();
  const canvases = useCanvases();
  const { reorder } = useCanvasActions();
  const [showHidden, setShowHidden] = useState(false);

  const all = canvases.data ?? [];
  const shown = shownCanvases(all, showHidden);
  const hiddenCount = all.filter((c) => c.hidden).length;

  const move = (canvas: Canvas, direction: -1 | 1) => {
    const ids = moveCanvas(
      all,
      shown.map((c) => c.id),
      canvas.id,
      direction,
    );
    if (!ids) return;
    void Haptics.selectionAsync();
    reorder.mutate(ids, { onError: () => alertError(t('common.actionFailed')) });
  };

  let body: ReactNode;
  if (canvases.isPending) body = <ActivityIndicator color={colors.textMuted} />;
  else if (canvases.isError) body = <LoadFailed onRetry={() => void canvases.refetch()} />;
  else if (shown.length === 0) {
    body = (
      <View style={styles.empty}>
        <T variant="headline" style={styles.centered}>
          {t('board.canvases.emptyTitle')}
        </T>
        <T variant="footnote" tone="muted" style={styles.centered}>
          {t('board.canvases.emptyBody')}
        </T>
      </View>
    );
  } else {
    body = (
      <View style={styles.stack}>
        {shown.map((canvas, index) => (
          <Animated.View
            key={canvas.id}
            entering={reveal(Math.min(index, 5))}
            exiting={leave}
            layout={settle}
          >
            <CanvasCard
              canvas={canvas}
              bot={byId.get(canvas.botId)}
              first={index === 0}
              last={index === shown.length - 1}
              onMove={(direction) => move(canvas, direction)}
            />
          </Animated.View>
        ))}
      </View>
    );
  }

  return (
    <Section title={t('board.canvases.title')}>
      {body}
      {hiddenCount > 0 && (
        <Touchable
          accessibilityRole="button"
          accessibilityState={{ expanded: showHidden }}
          onPress={() => setShowHidden((value) => !value)}
          hitSlop={8}
          style={styles.hiddenToggle}
        >
          <T variant="footnote" tone="faint">
            {t('board.canvases.hidden', { count: hiddenCount })} ·{' '}
            <T variant="footnote" tone="muted" style={styles.link}>
              {showHidden ? t('board.canvases.hideHidden') : t('board.canvases.showHidden')}
            </T>
          </T>
        </Touchable>
      )}
    </Section>
  );
}

/**
 * Home: a greeting (the large title), who is working and the global pause, the bots' questions,
 * a quick word to the Chef, and what the bots pinned (their news is in the Activity tab).
 */
export default function HomeScreen() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const me = useMe();
  const bots = useBots();
  const hour = useHour();
  const byId = botsById(bots.data);
  const chef = bots.data?.find((b) => b.isChef);

  const name = firstName(me.data?.owner.displayName);
  const title = me.data
    ? t(`board.greeting.${dayPeriod(hour)}`, { name }).trim()
    : t('board.title');

  const refresh = () =>
    Promise.all(HOME_QUERIES.map((queryKey) => client.refetchQueries({ queryKey })));

  return (
    <>
      <Stack.Screen options={{ title }} />
      <HomeScroll onRefresh={refresh}>
        {bots.data ? (
          <StatusCard bots={bots.data} chef={chef} />
        ) : bots.isError ? (
          <LoadFailed onRetry={() => void bots.refetch()} />
        ) : (
          <ActivityIndicator color={colors.textMuted} />
        )}
        <Questions byId={byId} />
        {chef && <AskChef chef={chef} />}
        <Canvases byId={byId} />
      </HomeScroll>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  flex: { flex: 1, minWidth: 0 },
  stack: { gap: spacing.md },
  centered: { textAlign: 'center' },
  // Status
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: 14 },
  crew: { flexDirection: 'row' },
  crewOverlap: { marginLeft: -14 },
  paused: { padding: 14, gap: 14 },
  pausedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  // Ask the Chef
  ask: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: shape.bar,
  },
  askInput: {
    ...type.callout,
    flex: 1,
    color: colors.text,
    minHeight: SEND,
    paddingVertical: isIOS ? 8 : 4,
  },
  send: {
    width: SEND,
    height: SEND,
    borderRadius: isAndroid ? 14 : SEND / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: colors.accentStrong,
  },
  sendIdle: { backgroundColor: 'rgba(243, 244, 246, 0.35)' },
  // Canvases
  empty: {
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 28,
    borderRadius: shape.card,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.borderStrong,
  },
  hiddenToggle: { alignSelf: 'center', paddingVertical: 4 },
  link: { fontWeight: '600' },
  failed: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.xs },
});
