import type { Bot, Question } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { ArrowUp, PenLine } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { questionsOfBot } from '../lib/board';
import { useAnswerQuestion, useQuestions } from '../lib/board-queries';
import { isAndroid, isIOS } from '../lib/platform';
import { timeAgo } from '../lib/time';
import { colors, shape, type } from '../theme';
import { leave, settle } from './board/motion';
import { Pill } from './board/pill';
import { BotAvatar } from './bot-avatar';
import { reveal } from './reveal';
import { Surface } from './ui/surface';
import { T } from './ui/text';
import { Touchable } from './ui/touchable';

const MAX_ANSWER = 2_000;
const SEND = isAndroid ? 40 : 36;

interface QuestionCardProps {
  question: Question;
  /** Who asks, with the time (on Home); left out in the bot's own chat. */
  bot?: Bot;
}

/**
 * A question a bot asked: one tap on a suggested answer, or the user's own words. The answer
 * reaches the bot as a message from the user.
 */
export function QuestionCard({ question, bot }: QuestionCardProps) {
  const { t, i18n } = useTranslation();
  const answer = useAnswerQuestion();
  const [writing, setWriting] = useState(question.options.length === 0);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || answer.isPending) return;
    setSent(trimmed);
    answer.mutate(
      { id: question.id, answer: trimmed },
      {
        onSuccess: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
      },
    );
  };

  return (
    <Surface style={styles.card}>
      <View style={styles.head}>
        {bot && <BotAvatar seed={bot.avatarSeed} size={30} mood="waiting" still />}
        <View style={styles.headText}>
          {bot && (
            <T variant="caption" tone="muted" numberOfLines={1}>
              {t('board.questions.from', { name: bot.name })} ·{' '}
              {timeAgo(question.createdAt, t, i18n.language)}
            </T>
          )}
          <T variant="callout" style={styles.question} selectable>
            {question.question}
          </T>
        </View>
      </View>

      {(question.options.length > 0 || !writing) && (
        <View style={styles.options}>
          {question.options.map((option) => (
            <Pill
              key={option}
              label={option}
              onPress={() => send(option)}
              disabled={answer.isPending && sent !== option}
              loading={answer.isPending && sent === option}
            />
          ))}
          {!writing && (
            <Pill
              variant="ghost"
              icon={PenLine}
              label={t('board.questions.other')}
              onPress={() => setWriting(true)}
              disabled={answer.isPending}
            />
          )}
        </View>
      )}

      {writing && (
        <View style={styles.write}>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus={question.options.length > 0}
            multiline
            maxLength={MAX_ANSWER}
            placeholder={t('board.questions.placeholder')}
            placeholderTextColor={colors.textFaint}
            selectionColor={isIOS ? colors.accentStrong : 'rgba(255, 255, 255, 0.35)'}
            cursorColor={colors.accentStrong}
            selectionHandleColor={colors.accentStrong}
            keyboardAppearance="dark"
            accessibilityLabel={t('board.questions.placeholder')}
            style={styles.input}
          />
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={t('board.questions.send')}
            onPress={() => send(text)}
            disabled={!text.trim() || answer.isPending}
            onAccent
            style={[styles.send, (!text.trim() || answer.isPending) && styles.sendIdle]}
          >
            <ArrowUp size={18} color={colors.accentInk} strokeWidth={2.4} />
          </Touchable>
        </View>
      )}

      {answer.isError && (
        <T variant="caption" tone="danger" accessibilityRole="alert">
          {t('common.actionFailed')}
        </T>
      )}
    </Surface>
  );
}

/** The bot's open questions, oldest first, above the message field of its chat. */
export function ChatQuestions({ botId }: { botId: string }) {
  const questions = useQuestions();
  const { height } = useWindowDimensions();
  const asked = questionsOfBot(questions.data, botId);
  if (asked.length === 0) return null;
  const cards = asked.map((question) => (
    <Animated.View key={question.id} entering={reveal()} exiting={leave} layout={settle}>
      <QuestionCard question={question} />
    </Animated.View>
  ));
  // Several questions scroll in their own box so the conversation stays visible.
  if (asked.length === 1) return cards;
  return (
    <ScrollView
      style={{ maxHeight: Math.round(height * 0.42) }}
      contentContainerStyle={styles.stack}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
    >
      {cards}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  question: { fontWeight: '600', color: colors.text },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  write: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    ...type.callout,
    flex: 1,
    color: colors.text,
    minHeight: SEND,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingTop: isIOS ? 8 : 6,
    paddingBottom: isIOS ? 8 : 6,
    borderRadius: shape.field,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    textAlignVertical: 'center',
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
  stack: { gap: 8 },
});
