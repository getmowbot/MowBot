import type { Bot, MessageMention } from '@mowbot/contract';
import * as Haptics from 'expo-haptics';
import { ArrowUp, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import {
  type CommandName,
  commandOf,
  filterCommands,
  insertMention,
  MENTION_LIMIT,
  type MentionTrigger,
  matches,
  mentionsToSend,
  pickerOpen,
  rankMatches,
  triggerAt,
} from '../../lib/chat-input';
import { useFileSearch } from '../../lib/files-queries';
import { isAndroid, isIOS } from '../../lib/platform';
import { type Outgoing, useBots, useStopBot, useTeams } from '../../lib/queries';
import { colors, shape, type } from '../../theme';
import { Surface } from '../ui/surface';
import { Touchable } from '../ui/touchable';
import { CommandSuggestions, MentionSuggestions } from './suggestions';
import { useChatCommands } from './use-chat-commands';

const MAX_LENGTH = 20_000;

interface Props {
  bot: Bot;
  onSend(message: Outgoing): void;
}

/** Tells a mention being typed from another: where its @ is and what follows. */
const triggerKey = (trigger: MentionTrigger) => `${trigger.start}:${trigger.query}`;

/**
 * The message field: send when there is text, stop while the bot works. `/` lists the commands
 * (a text that is exactly one runs it), `@` points at a bot, a team or a file of the workspace.
 */
export function Composer({ bot, onSend }: Props) {
  const { t } = useTranslation();
  const input = useRef<TextInput>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  // Mentions picked in the list; those still written in the text go with the message.
  const [picked, setPicked] = useState<MessageMention[]>([]);
  // The mention just completed: its picker stays closed until the user types on.
  const [closed, setClosed] = useState<string | null>(null);
  // Where the cursor goes once an inserted mention is on screen.
  const [placeCaret, setPlaceCaret] = useState<number | null>(null);
  const stop = useStopBot(bot.id);
  const { commands, run } = useChatCommands(bot);
  const working = bot.status === 'working';
  const empty = text.trim().length === 0;

  const trigger = triggerAt(text, caret);
  const mention = trigger?.kind === 'mention' && triggerKey(trigger) !== closed ? trigger : null;
  const query = mention?.query ?? null;

  const bots = useBots();
  const teams = useTeams();
  const files = useFileSearch(bot.workspaceId, query, MENTION_LIMIT);
  const label = (item: { name: string }) => item.name;
  const others = (bots.data ?? []).filter((b) => b.id !== bot.id);
  const botMatches = query === null ? [] : rankMatches(others, query, label);
  const teamMatches = query === null ? [] : rankMatches(teams.data ?? [], query, label);
  // The previous search shows until the new one answers: only what still matches.
  const fileMatches =
    query === null
      ? []
      : (files.data ?? []).filter((entry) => matches(query, entry.path)).slice(0, MENTION_LIMIT);
  const found = botMatches.length + teamMatches.length + fileMatches.length;
  const commandMatches = trigger?.kind === 'command' ? filterCommands(commands, trigger.query) : [];

  // After a mention is inserted, the cursor goes right after it (the new text is rendered).
  useEffect(() => {
    if (placeCaret === null) return;
    input.current?.setSelection(placeCaret, placeCaret);
    setPlaceCaret(null);
  }, [placeCaret]);

  const reset = () => {
    setText('');
    setCaret(0);
    setPicked([]);
    setClosed(null);
  };

  const change = (next: string) => {
    // Typing at the end: the cursor follows, even before its own event arrives.
    setCaret((at) => (at >= text.length ? next.length : Math.min(at, next.length)));
    setText(next);
  };

  const runCommand = (name: CommandName) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    reset();
    run(name);
  };

  const pick = (item: MessageMention) => {
    if (!mention) return;
    const next = insertMention(text, mention, item.label);
    const after = triggerAt(next.text, next.caret);
    void Haptics.selectionAsync();
    setText(next.text);
    setCaret(next.caret);
    setPlaceCaret(next.caret);
    setPicked((list) => [...list, item]);
    setClosed(after?.kind === 'mention' ? triggerKey(after) : null);
  };

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const names = commands.map((command) => command.name);
    const command = commandOf(value, names);
    if (command) {
      runCommand(command);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend({ text: value, mentions: mentionsToSend(value, picked) });
    reset();
  };

  return (
    <View>
      {commandMatches.length > 0 ? (
        <CommandSuggestions commands={commandMatches} onPick={runCommand} />
      ) : query !== null && pickerOpen(query, found) ? (
        <MentionSuggestions
          bots={botMatches}
          teams={teamMatches}
          files={fileMatches}
          searching={files.searching}
          onPick={pick}
        />
      ) : null}
      <Surface variant="bar" interactive radius={shape.bar} style={styles.bar}>
        <TextInput
          ref={input}
          value={text}
          onChangeText={change}
          onSelectionChange={(event) => setCaret(event.nativeEvent.selection.end)}
          multiline
          maxLength={MAX_LENGTH}
          placeholder={t('chat.placeholder', { name: bot.name })}
          placeholderTextColor={colors.textFaint}
          selectionColor={isIOS ? colors.accentStrong : 'rgba(255, 255, 255, 0.35)'}
          cursorColor={colors.accentStrong}
          selectionHandleColor={colors.accentStrong}
          keyboardAppearance="dark"
          style={styles.input}
          accessibilityLabel={t('chat.placeholder', { name: bot.name })}
        />
        <View style={styles.action}>
          {working && empty ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t('chat.stop')}
              onPress={() => stop.mutate()}
              disabled={stop.isPending}
              style={[styles.round, styles.stop]}
            >
              <Square size={13} color={colors.text} fill={colors.text} />
            </Touchable>
          ) : (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t('chat.send')}
              onPress={submit}
              disabled={empty}
              onAccent
              style={[styles.round, styles.send, empty && styles.sendIdle]}
            >
              <ArrowUp size={19} color={colors.accentInk} strokeWidth={2.4} />
            </Touchable>
          )}
        </View>
      </Surface>
    </View>
  );
}

const SIZE = isAndroid ? 40 : 36;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    minHeight: SIZE + 12,
  },
  input: {
    ...type.body,
    flex: 1,
    color: colors.text,
    maxHeight: 150,
    paddingHorizontal: 12,
    paddingTop: isIOS ? 8 : 6,
    paddingBottom: isIOS ? 8 : 6,
    textAlignVertical: 'center',
  },
  action: { height: SIZE, justifyContent: 'center' },
  round: {
    width: SIZE,
    height: SIZE,
    // Material 3: a small square-ish FAB shape; iOS: a circle.
    borderRadius: isAndroid ? 14 : SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  send: { backgroundColor: colors.accentStrong },
  sendIdle: { backgroundColor: 'rgba(243, 244, 246, 0.35)' },
  stop: { borderWidth: 1, borderColor: colors.borderStrong },
});
