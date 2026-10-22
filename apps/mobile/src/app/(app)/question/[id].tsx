import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowUp, ExternalLink, PenLine } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CanvasImage } from '../../../components/board/canvas-image';
import { BotAvatar } from '../../../components/bot-avatar';
import { Markdown } from '../../../components/markdown';
import { Button } from '../../../components/ui/button';
import { T } from '../../../components/ui/text';
import { Touchable } from '../../../components/ui/touchable';
import { useAnswerQuestion, useDismissQuestion, useQuestions } from '../../../lib/board-queries';
import { isAndroid, isIOS } from '../../../lib/platform';
import { useBots } from '../../../lib/queries';
import { timeAgo } from '../../../lib/time';
import { colors, currentScheme, fieldType, shape, themed, tint, type } from '../../../theme';

const MAX_ANSWER = 2_000;
const SEND = isAndroid ? 40 : 36;

/**
 * A question of a bot, as a native sheet: who asks, what it found (a picture, a few lines, a
 * link), then its answers as big buttons; or the user's own words, later, or set aside.
 */
export default function QuestionSheet() {
  const { t, i18n } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const questions = useQuestions();
  const bots = useBots();
  const answer = useAnswerQuestion();
  const dismiss = useDismissQuestion();
  const question = questions.data?.find((q) => q.id === id);
  const bot = bots.data?.find((b) => b.id === question?.botId);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!question) {
    return (
      <View style={[styles.sheet, styles.gone, { paddingBottom: insets.bottom + 24 }]}>
        <T tone="muted">{t('board.questions.answered')}</T>
        <Button label={t('common.close')} variant="secondary" onPress={close} />
      </View>
    );
  }

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || answer.isPending) return;
    setSent(trimmed);
    answer.mutate(
      { id: question.id, answer: trimmed },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          close();
        },
      },
    );
  };
  const options = writing ? [] : question.options;

  return (
    <ScrollView
      style={styles.sheet}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      <View style={styles.head}>
        {bot && <BotAvatar seed={bot.avatarSeed} size={36} mood="waiting" />}
        <T variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
          {bot ? t('board.questions.asks', { name: bot.name }) : t('board.questions.title_one')} ·{' '}
          {timeAgo(question.createdAt, t, i18n.language)}
        </T>
      </View>

      <T variant="title" selectable>
        {question.question}
      </T>

      {question.image && (
        <CanvasImage
          src={question.image}
          workspaceId={bot?.workspaceId ?? null}
          alt={question.question}
          version={question.id}
          style={styles.image}
        />
      )}
      {question.details && <Markdown text={question.details} style={styles.details} />}
      {question.link && (
        <Touchable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(question.link?.url ?? '')}
          style={styles.link}
        >
          <ExternalLink size={16} color={colors.text} />
          <T variant="callout" style={styles.linkText} numberOfLines={1}>
            {question.link.label}
          </T>
        </Touchable>
      )}

      <View style={styles.answers}>
        {options.map((option, index) => (
          <Button
            key={option}
            label={option}
            variant={index === 0 ? 'primary' : 'secondary'}
            onPress={() => send(option)}
            loading={answer.isPending && sent === option}
            disabled={answer.isPending && sent !== option}
          />
        ))}
        {writing ? (
          <View style={styles.write}>
            <TextInput
              value={text}
              onChangeText={setText}
              autoFocus
              multiline
              maxLength={MAX_ANSWER}
              placeholder={t('board.questions.placeholder')}
              placeholderTextColor={colors.textFaint}
              selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
              cursorColor={colors.accentStrong}
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
        ) : (
          <Touchable
            accessibilityRole="button"
            onPress={() => setWriting(true)}
            style={styles.other}
          >
            <PenLine size={15} color={colors.textMuted} />
            <T variant="callout" tone="muted">
              {t('board.questions.other')}
            </T>
          </Touchable>
        )}
      </View>

      {answer.isError && (
        <T variant="caption" tone="danger" accessibilityRole="alert">
          {t('common.actionFailed')}
        </T>
      )}

      <View style={styles.footer}>
        <Touchable accessibilityRole="button" onPress={close} style={styles.footerButton}>
          <T variant="callout" tone="muted">
            {t('board.questions.later')}
          </T>
        </Touchable>
        <Touchable
          accessibilityRole="button"
          accessibilityHint={t('board.questions.dismissHint')}
          onPress={() => {
            dismiss.mutate(question.id);
            close();
          }}
          style={styles.footerButton}
        >
          <T variant="callout" tone="faint">
            {t('board.questions.dismiss')}
          </T>
        </Touchable>
      </View>
    </ScrollView>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    sheet: { flex: 1, backgroundColor: isAndroid ? colors.surfaceContainerLow : colors.surface },
    content: { paddingHorizontal: 20, paddingTop: 22, gap: 14 },
    gone: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    shrink: { flexShrink: 1 },
    image: { width: '100%', height: 200, borderRadius: shape.card, borderCurve: 'continuous' },
    details: { color: colors.textMuted },
    link: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'flex-start',
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: shape.chip,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      backgroundColor: tint.ink(0.04),
    },
    linkText: { fontWeight: '600', flexShrink: 1 },
    answers: { gap: 10, marginTop: 4 },
    other: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 10,
    },
    write: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      padding: 6,
      paddingLeft: 14,
      borderRadius: shape.bar,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      backgroundColor: tint.ink(0.03),
    },
    input: {
      paddingTop: 6,
      paddingBottom: 6,
      ...fieldType(type.body, SEND),
      flex: 1,
      color: colors.text,
      minHeight: SEND,
      maxHeight: 140,
    },
    send: {
      width: SEND,
      height: SEND,
      borderRadius: isAndroid ? 14 : SEND / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentStrong,
      overflow: 'hidden',
    },
    sendIdle: { backgroundColor: tint.accent(0.35) },
    footer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    footerButton: { paddingVertical: 10, paddingHorizontal: 4 },
  }),
);
