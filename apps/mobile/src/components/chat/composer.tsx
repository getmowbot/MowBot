import type { Bot, MessageMention } from '@mowbot/contract';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { ArrowUp, Camera, FileText, Images, Paperclip, Square } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import {
  ATTACHMENT_MAX_BYTES,
  addAttachments,
  canSend,
  fromDocument,
  fromMedia,
  MAX_ATTACHMENTS,
  type PendingAttachment,
} from '../../lib/attachments';
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
import { formatSize } from '../../lib/files';
import { useFileSearch } from '../../lib/files-queries';
import { alertError, openOptions, showInfo } from '../../lib/options-menu';
import { isAndroid, isIOS } from '../../lib/platform';
import { projectsFor } from '../../lib/projects';
import { useProjects } from '../../lib/projects-queries';
import {
  type Outgoing,
  type OutgoingVoice,
  useBots,
  useStopBot,
  useTeams,
} from '../../lib/queries';
import { colors, shape, type } from '../../theme';
import { Surface } from '../ui/surface';
import { Touchable } from '../ui/touchable';
import { AttachmentStrip } from './attachment-strip';
import { useSizeUnits } from './message-files';
import { ProjectChip } from './project-chip';
import { CommandSuggestions, MentionSuggestions } from './suggestions';
import { useChatCommands } from './use-chat-commands';
import { HoldToRecord, RecordingBar, useVoiceRecorder } from './voice-recorder';

const MAX_LENGTH = 20_000;

interface Props {
  bot: Bot;
  /** Rejects when the message did not go: what was written and picked comes back. */
  onSend(message: Outgoing): Promise<unknown>;
  onSendVoice(voice: OutgoingVoice): void;
}

let picks = 0;
/** Tells two picks of the same file apart. */
const pickId = () => `${Date.now()}-${picks++}`;

/** Tells a mention being typed from another: where its @ is and what follows. */
const triggerKey = (trigger: MentionTrigger) => `${trigger.start}:${trigger.query}`;

/**
 * The message field: send when there is text or files, stop while the bot works, otherwise the
 * mic (hold to record a voice message). `/` lists the commands (a text that is exactly one runs
 * it), `@` points at a bot, a team or a file of the workspace; the paperclip attaches photos,
 * a picture taken now, or documents.
 */
export function Composer({ bot, onSend, onSendVoice }: Props) {
  const { t, i18n } = useTranslation();
  const units = useSizeUnits();
  const [attached, setAttached] = useState<PendingAttachment[]>([]);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  const voice = useVoiceRecorder(onSendVoice);
  // Files and recordings land in the bot's workspace.
  const canAttach = bot.workspaceId !== null;
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
  const empty = !canSend(text, attached);

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
  const projects = useProjects();
  const projectMatches =
    query === null ? [] : rankMatches(projectsFor(bot, projects.data), query, label);
  // The previous search shows until the new one answers: only what still matches.
  const fileMatches =
    query === null
      ? []
      : (files.data ?? []).filter((entry) => matches(query, entry.path)).slice(0, MENTION_LIMIT);
  const found = botMatches.length + teamMatches.length + projectMatches.length + fileMatches.length;
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

  const attach = (added: PendingAttachment[]) => {
    if (added.length === 0) return;
    const next = addAttachments(attachedRef.current, added);
    setAttached(next.list);
    if (next.tooBig) {
      alertError(
        t('chatMedia.attach.tooBig', {
          name: next.tooBig.name,
          size: formatSize(ATTACHMENT_MAX_BYTES, units, i18n.language),
        }),
      );
    } else if (next.overflow > 0) {
      alertError(t('chatMedia.attach.tooMany', { count: MAX_ATTACHMENTS }));
    }
  };

  const pickPhotos = async () => {
    const room = MAX_ATTACHMENTS - attachedRef.current.length;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, room),
      // JPEG rather than HEIC: every model and every browser reads it.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      quality: 0.85,
    });
    if (!result.canceled) attach(result.assets.map((a) => fromMedia(a, pickId(), new Date())));
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      alertError(t('chatMedia.attach.cameraDenied'));
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 });
    if (!result.canceled) attach(result.assets.map((a) => fromMedia(a, pickId(), new Date())));
  };

  const pickDocuments = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (!result.canceled) attach(result.assets.map((a) => fromDocument(a, pickId())));
  };

  const openAttach = () => {
    const safely = (pick: () => Promise<void>) => () =>
      void pick().catch(() => alertError(t('common.actionFailed')));
    openOptions({
      title: t('chatMedia.attach.add'),
      options: [
        { label: t('chatMedia.attach.photos'), icon: Images, onPress: safely(pickPhotos) },
        { label: t('chatMedia.attach.camera'), icon: Camera, onPress: safely(takePhoto) },
        { label: t('chatMedia.attach.document'), icon: FileText, onPress: safely(pickDocuments) },
      ],
    });
  };

  const submit = () => {
    const value = text.trim();
    const sending = attached;
    if (!canSend(value, sending)) return;
    const names = commands.map((command) => command.name);
    const command = sending.length === 0 ? commandOf(value, names) : null;
    if (command) {
      runCommand(command);
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const mentions = mentionsToSend(value, picked);
    onSend({ text: value, mentions, files: sending }).catch(() => {
      // Not sent: the files come back, unless others were picked meanwhile.
      if (attachedRef.current.length === 0) setAttached(sending);
      setText((current) => current || value);
    });
    reset();
    setAttached([]);
  };

  return (
    <View>
      <ProjectChip bot={bot} />
      {commandMatches.length > 0 ? (
        <CommandSuggestions commands={commandMatches} onPick={runCommand} />
      ) : query !== null && pickerOpen(query, found) ? (
        <MentionSuggestions
          bots={botMatches}
          teams={teamMatches}
          projects={projectMatches}
          files={fileMatches}
          searching={files.searching}
          onPick={pick}
        />
      ) : null}
      {attached.length > 0 && (
        <AttachmentStrip
          files={attached}
          onRemove={(id) => setAttached((list) => list.filter((file) => file.id !== id))}
        />
      )}
      <Surface variant="bar" interactive radius={shape.bar} style={styles.bar}>
        {canAttach && !voice.recording && (
          <View style={styles.action}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={t('chatMedia.attach.add')}
              onPress={openAttach}
              borderless
              style={[styles.round, styles.attach]}
            >
              <Paperclip size={19} color={colors.textMuted} />
            </Touchable>
          </View>
        )}
        {voice.recording ? (
          <RecordingBar elapsed={voice.elapsed} live={voice.live} slide={voice.slide} />
        ) : (
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
            style={[styles.input, canAttach && styles.inputAfterClip]}
            accessibilityLabel={t('chat.placeholder', { name: bot.name })}
          />
        )}
        <View style={styles.action}>
          {voice.recording || (empty && !working && canAttach) ? (
            <HoldToRecord
              recorder={voice}
              size={SIZE}
              onTap={() => showInfo(t('chatMedia.voice.holdHint'))}
            />
          ) : working && empty ? (
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
  attach: { backgroundColor: 'transparent' },
  inputAfterClip: { paddingLeft: 4 },
  sendIdle: { backgroundColor: 'rgba(243, 244, 246, 0.35)' },
  stop: { borderWidth: 1, borderColor: colors.borderStrong },
});
