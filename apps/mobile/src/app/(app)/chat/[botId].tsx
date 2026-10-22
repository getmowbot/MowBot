import type { Message } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { Sparkles } from 'lucide-react-native';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  type ListRenderItem,
  type ScrollViewProps,
  StyleSheet,
  View,
} from 'react-native';
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatHeader } from '../../../components/chat/chat-header';
import { Composer } from '../../../components/chat/composer';
import { ChatEmptyState } from '../../../components/chat/empty-state';
import { KeepInViewContext, type Measurable } from '../../../components/chat/keep-in-view';
import { BotMessage, IncomingMessage, UserMessage } from '../../../components/chat/messages';
import { discardRecording } from '../../../components/chat/voice-recorder';
import { ChatQuestions } from '../../../components/questions';
import { reveal } from '../../../components/reveal';
import { Button } from '../../../components/ui/button';
import { EdgeFade } from '../../../components/ui/edge-fade';
import { ShimmerText } from '../../../components/ui/shimmer-text';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import { moodOf } from '../../../lib/bot-mood';
import { revealOffset } from '../../../lib/chat-scroll';
import { incomingPlaces, inReadingOrder } from '../../../lib/incoming';
import { liveMessage } from '../../../lib/message-cache';
import {
  type Outgoing,
  type OutgoingVoice,
  useBots,
  useConversation,
  useProviders,
  useSendMessage,
  useSendVoice,
} from '../../../lib/queries';
import { colors, themed } from '../../../theme';

/** Under the message field: above the home indicator, and above the keyboard once open. */
const DOCK_GAP = 8;
const KEYBOARD_GAP = 12;
/** Between the last message and the message field. */
const LAST_MESSAGE_GAP = 28;
/** Room kept around a field typed into (below the header, above the message bar). */
const FIELD_MARGIN = 12;

/** Conversation with a bot: newest at the bottom, older pages loaded while scrolling up. */
export default function ChatScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const bots = useBots();
  const bot = bots.data?.find((b) => b.id === botId);
  const conversation = useConversation(botId);
  const providers = useProviders();
  const send = useSendMessage(botId);
  const sendVoice = useSendVoice(botId);
  const [headerHeight, setHeaderHeight] = useState(insets.top + 64);
  const [dockHeight, setDockHeight] = useState(insets.bottom + 64);
  const [error, setError] = useState<string | null>(null);
  // Messages already there when the chat opened appear at once; new ones settle in.
  const known = useRef<Set<string> | null>(null);
  const list = useRef<FlatList<Message>>(null);
  const dock = useRef<View>(null);
  const scrollY = useRef(0);

  const items = conversation.data?.items;
  useEffect(() => {
    if (items && !known.current) known.current = new Set(items.map((m) => m.id));
  }, [items]);

  const ordered = useMemo(() => inReadingOrder(items ?? []), [items]);
  const data = useMemo(() => [...ordered].reverse(), [ordered]);
  const places = useMemo(() => incomingPlaces(ordered), [ordered]);
  // Inverted: the item before a separator shows under it. Within a run, the bubbles stay close.
  const Separator = useCallback(
    ({ leadingItem }: { leadingItem?: Message }) => (
      <View
        style={
          leadingItem && places.get(leadingItem.id)?.run === null
            ? styles.runSeparator
            : styles.separator
        }
      />
    ),
    [places],
  );

  // Keyboard open: the home-indicator inset gives way to the keyboard, leaving KEYBOARD_GAP.
  const keyboardOffset = insets.bottom + DOCK_GAP - KEYBOARD_GAP;
  const renderScroll = useMemo(
    () => (props: ScrollViewProps) => (
      <KeyboardChatScrollView
        {...props}
        inverted
        offset={keyboardOffset}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
      />
    ),
    [keyboardOffset],
  );

  if (!bot) {
    return (
      <View style={[styles.root, styles.center]}>
        {bots.isPending ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <View style={styles.missing}>
            <T tone="muted">{t('common.botNotFound')}</T>
            <Button label={t('common.back')} variant="secondary" onPress={() => router.back()} />
          </View>
        )}
      </View>
    );
  }

  const live = liveMessage(conversation.data);
  const mood = moodOf(bot, live);
  const noModel = providers.isSuccess && (providers.data.length === 0 || !bot.model);

  // A field inside a message (a vault form): once the keyboard is up, scroll it into view.
  const keepInView = (field: Measurable) => {
    const reveal = () =>
      dock.current?.measureInWindow((_x, dockTop) =>
        field.measureInWindow((_fx, top, _width, height) => {
          const delta = revealOffset(
            { top, bottom: top + height },
            { top: headerHeight + FIELD_MARGIN, bottom: dockTop - FIELD_MARGIN },
          );
          if (delta !== 0) {
            list.current?.scrollToOffset({ offset: scrollY.current + delta, animated: true });
          }
        }),
      );
    if (Keyboard.isVisible()) {
      reveal();
      return;
    }
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      shown.remove();
      reveal();
    });
    // No software keyboard after all (a hardware one): nothing moved, nothing to do.
    setTimeout(() => shown.remove(), 1500);
  };

  const sendMessage = (message: Outgoing) => {
    setError(null);
    return send.mutateAsync(message).catch((failure: unknown) => {
      setError(t('errors.messageNotSent'));
      throw failure;
    });
  };

  /** Shown at once; the recording's file goes once the hub has it (or could not take it). */
  const sendRecording = (voice: OutgoingVoice) => {
    setError(null);
    sendVoice.mutate(voice, {
      onError: () => setError(t('chatMedia.voice.notSent')),
      onSettled: () => discardRecording(voice.uri),
    });
  };

  const renderItem: ListRenderItem<Message> = ({ item, index }) => {
    const seen = known.current;
    const fresh = seen !== null && !seen.has(item.id);
    seen?.add(item.id);
    const place = places.get(item.id);
    let content: ReactNode;
    if (item.role === 'assistant')
      content = (
        <BotMessage
          message={item}
          bot={bot}
          // Newest first: only the last answer can be resumed.
          onContinue={
            index === 0 && !send.isPending
              ? () => void sendMessage({ text: 'Continue' }).catch(() => {})
              : undefined
          }
        />
      );
    else if (place) content = <IncomingMessage message={item} place={place} bots={bots.data} />;
    else content = <UserMessage message={item} workspaceId={bot.workspaceId} />;
    return (
      <Animated.View entering={fresh ? reveal() : undefined}>
        <KeepInViewContext value={keepInView}>{content}</KeepInViewContext>
      </Animated.View>
    );
  };

  return (
    <View style={styles.root}>
      <FlatList
        ref={list}
        data={data}
        inverted
        onScroll={(event) => {
          scrollY.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        keyExtractor={(message) => message.id}
        renderItem={renderItem}
        renderScrollComponent={renderScroll}
        ItemSeparatorComponent={Separator}
        // Inverted: the header sits at the bottom (room for the composer), the footer on top.
        ListHeaderComponent={<View style={{ height: dockHeight + LAST_MESSAGE_GAP }} />}
        ListFooterComponent={
          <View style={[styles.top, { paddingTop: headerHeight + 8 }]}>
            {conversation.loadingOlder ? (
              <ActivityIndicator color={colors.textFaint} />
            ) : data.length > 0 && !conversation.data?.nextCursor ? (
              <T variant="caption" tone="faint">
                {t('chat.start')}
              </T>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          conversation.isSuccess ? (
            <View style={styles.empty}>
              <ChatEmptyState
                bot={bot}
                onPick={(text) => void sendMessage({ text }).catch(() => {})}
              />
            </View>
          ) : (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.textFaint} />
            </View>
          )
        }
        contentContainerStyle={styles.content}
        onEndReached={() => void conversation.loadOlder()}
        onEndReachedThreshold={0.6}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      />

      <ChatHeader
        bot={bot}
        mood={mood}
        live={live}
        onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}
      />

      <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} style={styles.dock}>
        <EdgeFade edge="bottom" style={styles.dockFade} />
        <View
          ref={dock}
          onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}
          style={[styles.dockInner, { paddingBottom: insets.bottom + DOCK_GAP }]}
        >
          {noModel && (
            <Surface style={styles.notice}>
              <Sparkles size={16} color={colors.text} />
              <T variant="footnote" style={styles.noticeText}>
                {t('chat.noModel', { name: bot.name })}
              </T>
            </Surface>
          )}
          {error && (
            <T variant="footnote" tone="danger" style={styles.error}>
              {error}
            </T>
          )}
          <ChatQuestions botId={bot.id} />
          {send.isPending && Boolean(send.variables?.files?.length) && (
            <ShimmerText style={styles.sending}>{t('chatMedia.attach.sending')}</ShimmerText>
          )}
          <Composer bot={bot} onSend={sendMessage} onSendVoice={sendRecording} />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    center: { alignItems: 'center', justifyContent: 'center' },
    missing: { alignItems: 'center', gap: 16 },
    content: { flexGrow: 1, paddingHorizontal: 16 },
    separator: { height: 22 },
    runSeparator: { height: 8 },
    top: { alignItems: 'center', paddingBottom: 12 },
    empty: { flex: 1, justifyContent: 'center', paddingVertical: 24 },
    dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    // From a little above the field down to the screen's edge: what scrolls under it blurs away.
    dockFade: { position: 'absolute', top: -20, left: 0, right: 0, bottom: 0 },
    dockInner: { paddingHorizontal: 12, gap: 8 },
    notice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
    noticeText: { flex: 1 },
    error: { paddingHorizontal: 8 },
    sending: { fontSize: 13, lineHeight: 18, paddingHorizontal: 8 },
  }),
);
