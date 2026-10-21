import type { Bot, Message } from '@mowbot/contract';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { segments } from '../../lib/activity';
import { moodOf } from '../../lib/bot-mood';
import { mentionSegments } from '../../lib/chat-input';
import { messageText } from '../../lib/message-cache';
import { colors } from '../../theme';
import { ActivityLine } from '../activity-line';
import { BotAvatar } from '../bot-avatar';
import { Markdown } from '../markdown';
import { ShimmerText } from '../ui/shimmer-text';
import { T } from '../ui/text';
import { MessageCanvas } from './message-canvas';
import { VaultRequest } from './vault-request';

/** Under a message that reached the bot while it worked: taken into its ongoing answer. */
function Steered({ message }: { message: Message }) {
  const { t } = useTranslation();
  if (!message.steered) return null;
  return (
    <T variant="caption" tone="faint" style={styles.steered}>
      {t('chat.steered')}
    </T>
  );
}

/** The user's text, each `@label` it pointed at stressed; a file mention opens the file. */
function MentionedText({ message, workspaceId }: { message: Message; workspaceId: string | null }) {
  // A hub from before mentions sends none.
  const segments = mentionSegments(messageText(message), message.mentions ?? []);
  let offset = 0;
  return (
    <T style={styles.userText} selectable>
      {segments.map(({ text, mention }) => {
        const key = offset;
        offset += text.length;
        if (!mention) return text;
        const open =
          mention.kind === 'file' && workspaceId
            ? () =>
                router.push({
                  pathname: '/files/[workspaceId]/view',
                  params: { workspaceId, path: mention.path },
                })
            : undefined;
        return (
          <T key={key} style={[styles.userText, styles.mention]} onPress={open}>
            {text}
          </T>
        );
      })}
    </T>
  );
}

export function UserMessage({
  message,
  workspaceId = null,
}: {
  message: Message;
  /** The bot's workspace, where its file mentions are. */
  workspaceId?: string | null;
}) {
  return (
    <View style={styles.sent}>
      <View style={styles.right}>
        <View style={[styles.bubble, styles.userBubble]}>
          <MentionedText message={message} workspaceId={workspaceId} />
        </View>
      </View>
      <Steered message={message} />
    </View>
  );
}

/** What another bot (or the user, for a task) gave this bot: a quieter, outlined bubble. */
export function IncomingMessage({ message, from }: { message: Message; from: Bot | undefined }) {
  const { t } = useTranslation();
  const name = from?.name ?? message.fromName ?? t('common.you');
  return (
    <View style={styles.sent}>
      <View style={styles.right}>
        <View style={[styles.bubble, styles.incomingBubble]}>
          <View style={styles.sender}>
            {(from || message.fromName) && (
              <BotAvatar seed={from?.avatarSeed ?? name} size={16} still />
            )}
            <T
              variant="caption"
              tone="muted"
              numberOfLines={1}
              onPress={
                from
                  ? () => router.push({ pathname: '/chat/[botId]', params: { botId: from.id } })
                  : undefined
              }
            >
              {t('chat.from', { name, kind: t(`chat.kind.${message.kind}`) })}
            </T>
          </View>
          <Markdown text={messageText(message)} style={styles.incomingText} />
        </View>
      </View>
      <Steered message={message} />
    </View>
  );
}

export function BotMessage({ message, bot }: { message: Message; bot: Bot }) {
  const { t } = useTranslation();
  const streaming = message.status === 'streaming';
  const blocks = segments(message.parts);
  return (
    <View style={styles.bot}>
      <BotAvatar seed={bot.avatarSeed} size={30} mood={streaming ? moodOf(bot, message) : 'idle'} />
      {/* First lines are centred on the 30pt avatar. */}
      <View style={styles.botBody}>
        {blocks.length === 0 && streaming && (
          <ShimmerText style={styles.thinking}>
            {t('chat.thinking', { name: bot.name })}
          </ShimmerText>
        )}
        {blocks.map((block, i) => {
          const last = i === blocks.length - 1;
          switch (block.kind) {
            case 'activity':
              return (
                <ActivityLine
                  key={`activity-${block.index}`}
                  parts={block.parts}
                  live={streaming && last}
                />
              );
            case 'canvas':
              return (
                <MessageCanvas
                  key={`canvas-${block.index}`}
                  message={message}
                  bot={bot}
                  part={block.part}
                  index={block.index}
                />
              );
            case 'vault':
              return (
                <VaultRequest
                  key={`vault-${block.index}`}
                  message={message}
                  part={block.part}
                  index={block.index}
                />
              );
            default:
              return (
                <Markdown key={`text-${block.index}`} text={block.text} caret={streaming && last} />
              );
          }
        })}
        {message.status === 'error' && (
          <View style={styles.error}>
            <T variant="footnote" tone="danger">
              {message.errorCode === 'no_model'
                ? t('chat.errorNoModel')
                : message.errorCode === 'hub_restart'
                  ? t('chat.hubRestart')
                  : (message.error ?? t('chat.error'))}
            </T>
          </View>
        )}
        {message.status === 'stopped' && (
          <T variant="caption" tone="faint">
            {t('chat.stopped')}
          </T>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sent: { gap: 5 },
  right: { flexDirection: 'row', justifyContent: 'flex-end' },
  steered: { textAlign: 'right', paddingHorizontal: 6 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 20,
    borderBottomRightRadius: 6,
    borderCurve: 'continuous',
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  userBubble: { backgroundColor: colors.accent },
  userText: { color: colors.accentInk },
  // Ink on the light bubble: bolder, on a faint tint.
  mention: { fontWeight: '600', backgroundColor: 'rgba(7, 8, 10, 0.08)' },
  incomingBubble: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    gap: 6,
  },
  incomingText: { fontSize: 14.5, lineHeight: 21 },
  sender: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bot: { flexDirection: 'row', gap: 12 },
  botBody: { flex: 1, minWidth: 0, gap: 10, paddingTop: 3 },
  thinking: { fontSize: 15, lineHeight: 23 },
  error: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 133, 0.25)',
    backgroundColor: 'rgba(255, 107, 133, 0.07)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
