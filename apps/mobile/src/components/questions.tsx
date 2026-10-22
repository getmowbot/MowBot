import type { Bot, Question } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import { ArrowUp, MessageCircleQuestion, PenLine } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { questionsOfBot } from '../lib/board';
import { useAnswerQuestion, useQuestions } from '../lib/board-queries';
import { isAndroid, isIOS } from '../lib/platform';
import { timeAgo } from '../lib/time';
import { colors, currentScheme, fieldType, shape, themed, tint, type } from '../theme';
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
            selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
            cursorColor={colors.accentStrong}
            selectionHandleColor={colors.accentStrong}
            keyboardAppearance={currentScheme()}
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

/** Questions shown as a sheet during this run of the app: each opens by itself once. */
const presented = new Set<string>();

/** Opens a bot's question as a native sheet. */
export function openQuestion(id: string): void {
  presented.add(id);
  router.push(`/question/${id}`);
}

/**
 * In a bot's chat: its newest open question opens by itself as a sheet (once), and each open
 * question stays a line above the message field, which opens it again.
 */
export function ChatQuestions({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const questions = useQuestions();
  const asked = questionsOfBot(questions.data, botId);
  const newest = asked.at(-1)?.id;
  useFocusEffect(
    useCallback(() => {
      if (!newest || presented.has(newest)) return;
      // Once the chat has settled on screen.
      const timer = setTimeout(() => openQuestion(newest), 400);
      return () => clearTimeout(timer);
    }, [newest]),
  );
  if (asked.length === 0) return null;
  return (
    <View style={styles.stack}>
      {asked.map((question) => (
        <Animated.View key={question.id} entering={reveal()} exiting={leave} layout={settle}>
          <Touchable
            accessibilityRole="button"
            accessibilityHint={t('board.questions.reply')}
            onPress={() => openQuestion(question.id)}
          >
            <Surface style={styles.line}>
              <View style={styles.lineIcon}>
                <MessageCircleQuestion size={16} color={colors.info} />
              </View>
              <T variant="callout" numberOfLines={2} style={styles.lineText}>
                {question.question}
              </T>
              <T variant="footnote" style={styles.lineReply}>
                {t('board.questions.reply')}
              </T>
            </Surface>
          </Touchable>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    card: { padding: 14, gap: 12 },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    question: { fontWeight: '600', color: colors.text },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    write: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
    input: {
      paddingTop: 6,
      paddingBottom: 6,
      ...fieldType(type.callout, SEND),
      flex: 1,
      color: colors.text,
      minHeight: SEND,
      maxHeight: 120,
      paddingHorizontal: 14,
      borderRadius: shape.field,
      borderCurve: 'continuous',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      backgroundColor: tint.ink(0.03),
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
    sendIdle: { backgroundColor: tint.accent(0.35) },
    stack: { gap: 8 },
    line: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, paddingRight: 14 },
    lineIcon: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: tint.ink(0.05),
    },
    lineText: { flex: 1, minWidth: 0, fontWeight: '600' },
    lineReply: { fontWeight: '600', color: colors.textMuted },
  }),
);
