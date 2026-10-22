import type { Bot, MessageMention } from '@mowbot/contract';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { ArrowUp, Camera, FileText, Images, Paperclip, Square } from 'lucide-react-native';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';
import { useModelListings } from '../../lib/admin-queries';
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
  MODEL_PREFIX,
  matches,
  mentionsToSend,
  pickerOpen,
  rankMatches,
  triggerAt,
} from '../../lib/chat-input';
import { formatSize } from '../../lib/files';
import { useFileSearch } from '../../lib/files-queries';
import { type ModelChoice, modelGroups } from '../../lib/model-choices';
import { alertError, openOptions, showInfo } from '../../lib/options-menu';
import { useSetModel } from '../../lib/org-queries';
import { isAndroid, isIOS } from '../../lib/platform';
import { projectsFor } from '../../lib/projects';
import { useProjects } from '../../lib/projects-queries';
import {
  type Outgoing,
  type OutgoingVoice,
  useBots,
  useProviders,
  useStopBot,
  useTeams,
} from '../../lib/queries';
import { colors, currentScheme, fieldType, themed, tint, type } from '../../theme';
import { Lens } from '../ui/lens';
import { Pebble } from '../ui/pebble';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';
import { AttachmentStrip } from './attachment-strip';
import { useSizeUnits } from './message-files';
import { ProjectChip } from './project-chip';
import { CommandSuggestions, MentionSuggestions, ModelSuggestions } from './suggestions';
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
  // `/model` lists the models over the field; the words typed after it narrow them down.
  const { commands, run } = useChatCommands(bot, () => {
    setText(MODEL_PREFIX);
    setCaret(MODEL_PREFIX.length);
    setPlaceCaret(MODEL_PREFIX.length);
  });
  const working = bot.status === 'working';
  const empty = !canSend(text, attached);
  const [focused, setFocused] = useState(false);
  // The send button's reflection runs across when it lights up, and when pressed.
  const [sweep, setSweep] = useState(0);
  const wasEmpty = useRef(empty);
  useEffect(() => {
    if (wasEmpty.current && !empty) setSweep((n) => n + 1);
    wasEmpty.current = empty;
  }, [empty]);

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
  const modelQuery = trigger?.kind === 'model' ? trigger.query : null;
  const providers = useProviders();
  const listings = useModelListings(providers.data ?? [], modelQuery !== null);
  const models =
    modelQuery === null ? [] : modelGroups(providers.data ?? [], listings, bot, modelQuery);
  const setModel = useSetModel(bot.id);
  // What `/model` just did ("Nova now uses …"), for a few seconds.
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 4000);
    return () => clearTimeout(timer);
  }, [done]);

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

  const pickModel = (choice: ModelChoice) => {
    void Haptics.selectionAsync();
    reset();
    if (choice.current) return;
    setModel.mutate(
      { providerId: choice.providerId, model: choice.id },
      {
        onSuccess: () => setDone(t('chatInput.model.set', { name: bot.name, model: choice.id })),
        onError: () => alertError(t('chatInput.model.failed')),
      },
    );
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
    // `/model gpt` picks the model that matches best, never goes to the bot.
    if (modelQuery !== null && sending.length === 0) {
      const best = models.flatMap((group) => group.models)[0];
      if (best) pickModel(best);
      else if (modelQuery.trim() && !models.some((group) => group.state === 'loading')) {
        alertError(t('chatInput.model.none', { query: modelQuery.trim() }));
      }
      return;
    }
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
      ) : modelQuery !== null ? (
        <ModelSuggestions
          groups={models}
          query={modelQuery}
          providers={providers.isPending ? null : (providers.data?.length ?? 0)}
          onPick={pickModel}
        />
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
      {done ? (
        <T variant="footnote" tone="muted" style={styles.done} accessibilityLiveRegion="polite">
          {done}
        </T>
      ) : null}
      {attached.length > 0 && (
        <AttachmentStrip
          files={attached}
          onRemove={(id) => setAttached((list) => list.filter((file) => file.id !== id))}
        />
      )}
      <Lens focused={focused} style={styles.bar}>
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
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            multiline
            maxLength={MAX_LENGTH}
            placeholder={t('chat.placeholder', { name: bot.name })}
            placeholderTextColor={colors.textFaint}
            selectionColor={isIOS ? colors.accentStrong : tint.ink(0.35)}
            cursorColor={colors.accentStrong}
            selectionHandleColor={colors.accentStrong}
            keyboardAppearance={currentScheme()}
            style={[styles.input, canAttach && styles.inputAfterClip]}
            accessibilityLabel={t('chat.placeholder', { name: bot.name })}
          />
        )}
        <View style={styles.action}>
          {voice.recording || (empty && !working && canAttach) ? (
            <Swap key="mic">
              <HoldToRecord
                recorder={voice}
                size={SIZE}
                onTap={() => showInfo(t('chatMedia.voice.holdHint'))}
              />
            </Swap>
          ) : working && empty ? (
            <Swap key="stop">
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={t('chat.stop')}
                onPress={() => stop.mutate()}
                disabled={stop.isPending}
                style={[styles.round, styles.stop]}
              >
                <Square size={13} color={colors.text} fill={colors.text} />
              </Touchable>
            </Swap>
          ) : (
            <Swap key="send">
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={t('chat.send')}
                onPress={() => {
                  setSweep((n) => n + 1);
                  submit();
                }}
                disabled={empty}
                onAccent
                style={styles.round}
              >
                <Pebble size={SIZE} sweep={sweep} disabled={empty}>
                  <ArrowUp size={19} color={colors.pebbleInk} strokeWidth={2.4} />
                </Pebble>
              </Touchable>
            </Swap>
          )}
        </View>
      </Lens>
    </View>
  );
}

/** The round buttons, as on the web. */
const SIZE = 40;

/** The send, stop and mic buttons trade places with a quick zoom. */
function Swap({ children }: { children: ReactNode }) {
  return (
    <Animated.View entering={ZoomIn.duration(180)} exiting={ZoomOut.duration(120)}>
      {children}
    </Animated.View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      padding: 6,
      gap: 6,
      minHeight: SIZE + 14,
    },
    input: {
      paddingTop: 6,
      paddingBottom: 6,
      // Its one line level with the round buttons.
      ...fieldType(type.body, SIZE),
      flex: 1,
      color: colors.text,
      minHeight: SIZE,
      maxHeight: 220,
      paddingHorizontal: 10,
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
    attach: { backgroundColor: 'transparent' },
    inputAfterClip: { paddingLeft: 4 },
    done: { paddingHorizontal: 12, paddingBottom: 8 },
    stop: { borderWidth: 1, borderColor: colors.borderStrong },
  }),
);
