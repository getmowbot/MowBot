import type { Bot, Message } from '@mowbot/contract';
import { router } from 'expo-router';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, type TextStyle, View } from 'react-native';
import { segments } from '../../lib/activity';
import { userMedia } from '../../lib/attachments';
import { moodOf } from '../../lib/bot-mood';
import { mentionSegments } from '../../lib/chat-input';
import {
  chipBots,
  type IncomingPlace,
  runSummary,
  senderOf,
  shortSummary,
  summaryOf,
} from '../../lib/incoming';
import { messageText } from '../../lib/message-cache';
import { colors, themed, tint } from '../../theme';
import { ActivityLine } from '../activity-line';
import { BotAvatar } from '../bot-avatar';
import { BotChip } from '../bot-chip';
import { Markdown } from '../markdown';
import { ShimmerText } from '../ui/shimmer-text';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { type Talk, TalkLine, TalkSheet } from './bot-talk';
import { MessageCanvas } from './message-canvas';
import { MessageFiles } from './message-files';
import { TakeoverRequest } from './takeover-request';
import { VaultRequest } from './vault-request';
import { VoiceMessage } from './voice-message';

/** Under a message that reached the bot while it worked: taken into its ongoing answer. */
function Steered({ message, style }: { message: Message; style?: TextStyle }) {
  const { t } = useTranslation();
  if (!message.steered) return null;
  return (
    <T variant="caption" tone="faint" style={[styles.steered, style]}>
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

/** What the user sent: a voice message, pictures and files, their text. */
export function UserMessage({
  message,
  workspaceId = null,
}: {
  message: Message;
  /** The bot's workspace, where its file mentions are. */
  workspaceId?: string | null;
}) {
  const { pictures, files, voice } = userMedia(message.parts);
  const text = messageText(message).trim().length > 0;
  return (
    <View style={styles.sent}>
      {voice && (
        <View style={styles.right}>
          <VoiceMessage message={message} part={voice} />
        </View>
      )}
      {(pictures.length > 0 || files.length > 0) && (
        <View style={styles.right}>
          <MessageFiles pictures={pictures} files={files} version={message.id} />
        </View>
      )}
      {text && (
        <View style={styles.right}>
          <View style={[styles.bubble, styles.userBubble]}>
            <MentionedText message={message} workspaceId={workspaceId} />
          </View>
        </View>
      )}
      <Steered message={message} />
    </View>
  );
}

/** Above a run of incoming messages, quietly: who sent them, and what they are. */
function IncomingLine({ run, bots }: { run: Message[]; bots: Bot[] | undefined }) {
  const { t } = useTranslation();
  const { senders, kinds } = runSummary(run);
  const what = kinds.map((kind) => t(`chat.kind.${kind}`)).join(', ');
  if (senders.length === 0) {
    return (
      <T variant="caption" tone="faint" style={styles.line}>
        {what.charAt(0).toUpperCase() + what.slice(1)}
      </T>
    );
  }
  return (
    <T variant="caption" tone="faint" style={styles.line}>
      {t('chat.incoming', { count: run.length })}{' '}
      {senders.map((sender, i) => {
        const key = sender.kind === 'bot' ? (sender.id ?? sender.name) : sender.kind;
        const bot = sender.kind === 'bot' ? bots?.find((b) => b.id === sender.id) : undefined;
        return (
          <Fragment key={key}>
            {i > 0 && (i === senders.length - 1 ? ` ${t('chat.and')} ` : ', ')}
            {sender.kind === 'bot' ? (
              <BotChip
                plain
                bot={bot ?? { id: null, name: sender.name, avatarSeed: sender.name }}
              />
            ) : (
              <T variant="caption" tone="muted" style={styles.you}>
                {t('common.you')}
              </T>
            )}
          </Fragment>
        );
      })}
      {what ? ` · ${what}` : null}
    </T>
  );
}

/** What another bot wrote: one line with its sender and the gist, the whole message a tap away. */
function FromBotMessage({ message, bots }: { message: Message; bots: Bot[] | undefined }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chips = useMemo(() => chipBots(bots, message), [bots, message]);
  const name = message.fromName ?? '';
  const bot = bots?.find((b) => b.id === message.fromBotId) ?? {
    id: null,
    name,
    avatarSeed: name,
  };
  const talk: Talk = {
    title: t(`chat.talk.from.${message.kind}`, { name: bot.name }),
    bot,
    text: messageText(message),
    at: message.createdAt,
  };
  return (
    <View style={styles.incoming}>
      <TalkLine
        title={talk.title}
        bot={bot}
        summary={summaryOf(message)}
        onPress={() => setOpen(true)}
      />
      <TalkSheet talk={talk} chips={chips} visible={open} onClose={() => setOpen(false)} />
      <Steered message={message} style={styles.centered} />
    </View>
  );
}

/**
 * What the user (a task) or a routine gave this bot: a soft bubble under a quiet line saying
 * what it is; another bot's message, a line opening it.
 */
export function IncomingMessage({
  message,
  place,
  bots,
}: {
  message: Message;
  place: IncomingPlace;
  bots: Bot[] | undefined;
}) {
  const chips = useMemo(() => chipBots(bots, message), [bots, message]);
  if (senderOf(message).kind === 'bot') return <FromBotMessage message={message} bots={bots} />;
  return (
    <View style={styles.incoming}>
      {place.run && <IncomingLine run={place.run} bots={bots} />}
      <View style={styles.incomingBubble}>
        <Markdown text={messageText(message)} bots={chips} style={styles.incomingText} />
      </View>
      <Steered message={message} style={styles.centered} />
    </View>
  );
}

/** Under an answer cut by the step limit; the last one can be resumed. */
function StepLimit({ onContinue }: { onContinue?: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.stepLimit}>
      <T variant="caption" tone="faint">
        {t('chat.stepLimit')}
      </T>
      {onContinue && (
        <Touchable accessibilityRole="button" onPress={onContinue} style={styles.continue}>
          <T variant="caption" tone="muted">
            {t('chat.continue')}
          </T>
        </Touchable>
      )}
    </View>
  );
}

export function BotMessage({
  message,
  bot,
  onContinue,
}: {
  message: Message;
  bot: Bot;
  /** Cut by the step limit and still the last answer: the user can tell the bot to go on. */
  onContinue?: () => void;
}) {
  const { t } = useTranslation();
  const [unfolded, setUnfolded] = useState(false);
  const streaming = message.status === 'streaming';
  const blocks = segments(message.parts);
  // An answer to other bots or a routine: its first sentence, the rest a tap away.
  const said = blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : [])).join('\n\n');
  // A hub from before this sends no `autonomous`.
  const gist = message.autonomous && !streaming ? shortSummary(said) : '';
  const foldable = gist !== '' && said.trim().length > gist.length + 40;
  const folded = foldable && !unfolded;
  const firstText = blocks.findIndex((b) => b.kind === 'text');
  const lastText = blocks.findLastIndex((b) => b.kind === 'text');
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
            case 'takeover':
              return (
                <TakeoverRequest
                  key={`takeover-${block.index}`}
                  part={block.part}
                  botName={bot.name}
                />
              );
            default:
              if (folded) {
                return i === firstText ? (
                  <Touchable
                    key={`text-${block.index}`}
                    onPress={() => setUnfolded(true)}
                    accessibilityRole="button"
                    accessibilityHint={t('chat.readMore')}
                  >
                    <T tone="muted">
                      {gist}{' '}
                      <T variant="footnote" tone="faint">
                        · {t('chat.readMore')}
                      </T>
                    </T>
                  </Touchable>
                ) : null;
              }
              return (
                <Fragment key={`text-${block.index}`}>
                  <Markdown text={block.text} caret={streaming && last} />
                  {foldable && i === lastText && (
                    <Touchable
                      onPress={() => setUnfolded(false)}
                      accessibilityRole="button"
                      style={styles.readLess}
                    >
                      <T variant="caption" tone="faint">
                        {t('chat.readLess')}
                      </T>
                    </Touchable>
                  )}
                </Fragment>
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
        {message.status === 'done' && message.stepLimit && <StepLimit onContinue={onContinue} />}
      </View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
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
    mention: { fontWeight: '600', backgroundColor: tint.onAccent(0.08) },
    incoming: { alignItems: 'center', gap: 6 },
    line: { textAlign: 'center', lineHeight: 20, paddingHorizontal: 12 },
    you: { fontWeight: '600' },
    incomingBubble: {
      maxWidth: '92%',
      borderRadius: 18,
      borderCurve: 'continuous',
      paddingHorizontal: 15,
      paddingVertical: 10,
      backgroundColor: tint.ink(0.055),
    },
    incomingText: { fontSize: 14, lineHeight: 21, color: tint.text(0.88) },
    centered: { textAlign: 'center' },
    bot: { flexDirection: 'row', gap: 12 },
    botBody: { flex: 1, minWidth: 0, gap: 10, paddingTop: 3 },
    thinking: { fontSize: 15, lineHeight: 23 },
    stepLimit: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    readLess: { alignSelf: 'flex-start', paddingVertical: 2 },
    continue: {
      borderRadius: 9999,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      paddingHorizontal: 10,
      paddingVertical: 3,
      overflow: 'hidden',
    },
    error: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: tint.danger(0.25),
      backgroundColor: tint.danger(0.07),
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
  }),
);
