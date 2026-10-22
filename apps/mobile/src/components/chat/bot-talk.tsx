import type { Bot } from '@mowbot/contract';
import { router } from 'expo-router';
import { MessageSquareText, X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChipBot } from '../../lib/incoming';
import { timeAgo } from '../../lib/time';
import { colors, themed } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { Markdown } from '../markdown';
import { IconButton } from '../ui/button';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/** What bots said to each other, opened large. */
export interface Talk {
  /** "Message de Nova", "Question à Hans"… */
  title: string;
  /** The other bot: its conversation opens from the talk (a deleted bot has no id). */
  bot: ChipBot;
  text: string;
  /** A question's answer, once it came back. */
  answer?: { title: string; text: string };
  at?: string;
}

/** Every bot as a chip, for the names a talk's text holds. */
export const chipsOf = (bots: Bot[] | undefined): ChipBot[] =>
  (bots ?? []).map(({ id, name, avatarSeed, isChef }) => ({ id, name, avatarSeed, isChef }));

/**
 * A message between bots, as a small grey mark: the sender's face and what happened ("Milo
 * a écrit"), nothing more. A tap opens it large.
 */
export function TalkLine({
  line,
  bot,
  summary,
  note,
  onPress,
}: {
  line: string;
  bot: ChipBot;
  /** What it says in a few words: for screen readers, the line itself stays short. */
  summary: string;
  /** A quiet addition after it ("pris en compte"). */
  note?: string;
  onPress(): void;
}) {
  return (
    <Touchable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={summary ? `${line} · ${summary}` : line}
      hitSlop={{ top: 6, bottom: 6 }}
      style={styles.line}
    >
      <BotAvatar seed={bot.avatarSeed} size={16} still />
      <T variant="caption" tone="faint" numberOfLines={1} style={styles.lineText}>
        {note ? `${line} · ${note}` : line}
      </T>
    </Touchable>
  );
}

/** A talk opened large in a sheet: the whole text, the answer under it, a way to the other bot. */
export function TalkSheet({
  talk,
  chips,
  visible,
  onClose,
}: {
  talk: Talk;
  chips: ChipBot[];
  visible: boolean;
  onClose(): void;
}) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { bot } = talk;
  const openChat = () => {
    onClose();
    if (bot.id) router.push({ pathname: '/chat/[botId]', params: { botId: bot.id } });
  };
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={styles.header}>
          <BotAvatar seed={bot.avatarSeed} size={32} still />
          <View style={styles.heading}>
            <T variant="headline" numberOfLines={1}>
              {talk.title}
            </T>
            {talk.at ? (
              <T variant="caption" tone="faint">
                {timeAgo(talk.at, t, i18n.language)}
              </T>
            ) : null}
          </View>
          <IconButton icon={X} label={t('common.close')} onPress={onClose} size={36} />
        </View>
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 28 }]}>
          <Markdown text={talk.text} bots={chips} />
          {talk.answer ? (
            <View style={styles.answer}>
              <View style={styles.answerTitle}>
                <MessageSquareText size={13} color={colors.textFaint} />
                <T variant="caption" tone="faint" style={styles.strong}>
                  {talk.answer.title}
                </T>
              </View>
              <Markdown text={talk.answer.text} bots={chips} />
            </View>
          ) : null}
          {bot.id ? (
            <Touchable onPress={openChat} accessibilityRole="link" style={styles.open}>
              <T variant="callout" tone="muted">
                {t('chat.talk.openChat', { name: bot.name })} →
              </T>
            </Touchable>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    line: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '92%' },
    lineText: { flexShrink: 1 },
    sheet: { flex: 1, backgroundColor: colors.backgroundRaised },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 18,
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    heading: { flex: 1, minWidth: 0 },
    body: { paddingHorizontal: 20, paddingTop: 18, gap: 22 },
    answer: {
      gap: 8,
      paddingTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    answerTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    strong: { fontWeight: '600' },
    open: { alignSelf: 'flex-end', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6 },
  }),
);
