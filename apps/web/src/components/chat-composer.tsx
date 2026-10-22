import { type Bot, MAX_ATTACHMENTS, type Mention } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  ArrowUp,
  Blocks,
  Check,
  Cpu,
  Eraser,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  KeyRound,
  type LucideIcon,
  Mic,
  Monitor,
  Paperclip,
  Pencil,
  Repeat,
  Settings2,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/auth';
import {
  insertMention,
  matches,
  mentionsToSend,
  type Picked,
  type Trigger,
  triggerAt,
} from '../lib/chat-input';
import { useDraft } from '../lib/drafts';
import { formatSize, IMAGE } from '../lib/files';
import { type ModelChoice, modelGroups } from '../lib/models';
import { projectsFor, useProjects } from '../lib/projects';
import { useBots, useListings, useProviders, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';
import {
  canRecord,
  formatDuration,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  type Recording,
  VoiceRecorder,
} from '../lib/voice';
import { BotAvatar } from './bot-avatar';
import { useClearConversation } from './bot-menu';
import { fileLook } from './canvas-body';
import { useOrgDialogs } from './org-dialogs';
import { ProjectChip } from './project-chip';
import { ProviderMark } from './provider-mark';
import { Button } from './ui/button';

/** A `/` command of the composer: done in the app, never sent to the bot. */
type CommandName =
  | 'stop'
  | 'clear'
  | 'project'
  | 'model'
  | 'pc'
  | 'files'
  | 'settings'
  | 'rename'
  | 'move'
  | 'mcp'
  | 'vault'
  | 'routines';

interface ChatCommand {
  /** Typed after the slash, the same in every language. */
  name: CommandName;
  icon: LucideIcon;
  run(): void;
}

/** The commands of a conversation, for what this bot has (a PC, a workspace…). */
function useChatCommands(
  bot: Bot,
  actions: {
    togglePc(): void;
    rename(): void;
    pickProject: (() => void) | null;
    pickModel(): void;
  },
): ChatCommand[] {
  const navigate = useNavigate();
  const dialogs = useOrgDialogs();
  const queryClient = useQueryClient();
  const clear = useClearConversation(bot);
  const stop = useMutation({
    mutationFn: () => api.POST('/api/v1/bots/{id}/stop', { params: { path: { id: bot.id } } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['bots'] }),
  });
  const { workspaceId } = bot;
  const commands: (ChatCommand | null)[] = [
    { name: 'stop', icon: Square, run: () => stop.mutate() },
    { name: 'clear', icon: Eraser, run: clear },
    actions.pickProject ? { name: 'project', icon: FolderGit2, run: actions.pickProject } : null,
    { name: 'model', icon: Cpu, run: actions.pickModel },
    bot.computerId ? { name: 'pc', icon: Monitor, run: actions.togglePc } : null,
    workspaceId
      ? {
          name: 'files',
          icon: FolderOpen,
          run: () =>
            void navigate({ to: '/workspaces/$workspaceId/files', params: { workspaceId } }),
        }
      : null,
    { name: 'settings', icon: Settings2, run: () => dialogs.botSettings(bot) },
    { name: 'rename', icon: Pencil, run: actions.rename },
    bot.isChef ? null : { name: 'move', icon: ArrowRightLeft, run: () => dialogs.moveBot(bot) },
    { name: 'mcp', icon: Blocks, run: () => void navigate({ to: '/settings/mcp' }) },
    { name: 'vault', icon: KeyRound, run: () => void navigate({ to: '/vault' }) },
    { name: 'routines', icon: Repeat, run: () => void navigate({ to: '/routines' }) },
  ];
  return commands.filter((command) => command !== null);
}

/** What `/model` becomes once picked: the models show, the words typed after narrow them. */
const MODEL_PREFIX = '/model ';

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

type Option =
  | { key: string; section: 'commands'; command: ChatCommand }
  | { key: string; section: 'models'; model: ModelChoice }
  | {
      key: string;
      section: 'bots' | 'teams' | 'projects' | 'files';
      picked: Picked;
      icon: ReactNode;
      hint: string;
    };

const SECTIONS = ['commands', 'bots', 'teams', 'projects', 'files'] as const;

/** The hub takes files up to this size in a conversation. */
const ATTACHMENT_MAX_BYTES = 100 * 1024 ** 2;
/** Live bars while recording. */
const LIVE_BARS = 36;

/** A file picked for the next message; pictures show a thumbnail. */
interface PendingFile {
  id: string;
  file: File;
  preview: string | null;
}

/** Frees the thumbnails of files no longer about to be sent. */
function forget(list: PendingFile[]) {
  for (const item of list) if (item.preview) URL.revokeObjectURL(item.preview);
}

/** The pictures and files about to be sent, each with a way to take it back. */
function PendingFiles({ files, onRemove }: { files: PendingFile[]; onRemove(id: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-2 overflow-x-auto px-1 pt-1 pb-2">
      {files.map(({ id, file, preview }) => {
        const { icon: Icon, tone } = fileLook({ type: 'file', name: file.name });
        return (
          <motion.div
            key={id}
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={springs.snappy}
            className="group relative shrink-0"
            title={file.name}
          >
            {preview ? (
              <img
                src={preview}
                alt={file.name}
                className="size-16 rounded-xl border border-border object-cover"
              />
            ) : (
              <div className="flex h-16 w-44 items-center gap-2.5 rounded-xl border border-border bg-ink/[0.03] px-2.5">
                <span className={cn('shrink-0', tone)}>
                  <Icon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{file.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {formatSize(file.size)}
                  </span>
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => onRemove(id)}
              aria-label={t('chat.attach.remove', { name: file.name })}
              className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border-strong bg-card text-muted-foreground shadow transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}

/** While recording: a red dot, the time, the live level. */
function RecordingBar({ elapsed, levels }: { elapsed: number; levels: number[] }) {
  const { t } = useTranslation();
  const bars = [...Array.from({ length: LIVE_BARS - levels.length }, () => 0), ...levels];
  return (
    <div
      role="status"
      aria-label={t('chat.voice.recording')}
      className="flex min-h-10 min-w-0 flex-1 items-center gap-3 px-2.5"
    >
      <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" />
      <span className="w-10 shrink-0 font-mono text-sm tabular-nums">
        {formatDuration(elapsed)}
      </span>
      <span className="flex h-7 min-w-0 flex-1 items-center gap-[3px] overflow-hidden">
        {bars.map((level, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a rolling window of levels
            key={i}
            style={{ height: `${Math.max(10, Math.min(1, level * 6) * 100)}%` }}
            className="w-[3px] shrink-0 rounded-full bg-foreground/70 transition-[height] duration-75"
          />
        ))}
      </span>
    </div>
  );
}

/**
 * The message field: `/` runs a command, `@` points at a bot, a team, a project or a file.
 * Files come with the paperclip, a drop or a paste; the mic records a voice message (click to
 * start, the arrow sends it, the bin drops it).
 */
export function ChatComposer({
  bot,
  onTogglePc,
  onRename,
  onSend,
  onSendVoice,
}: {
  bot: Bot;
  onTogglePc(): void;
  onRename(): void;
  /** Rejects when the message did not go: what was written comes back. */
  onSend(text: string, mentions: Mention[], files: File[]): Promise<unknown>;
  onSendVoice(recording: Recording): Promise<unknown>;
}) {
  const { t } = useTranslation();
  // The project the bot works in: a chip over the field, `/project` opens its menu.
  const [projectMenu, setProjectMenu] = useState(false);
  const projects = projectsFor(bot, useProjects().data);
  const commands = useChatCommands(bot, {
    togglePc: onTogglePc,
    rename: onRename,
    pickProject: projects.length > 0 ? () => setProjectMenu(true) : null,
    // The models show in the list over the field; what follows `/model ` narrows them down.
    pickModel: () => {
      setText(MODEL_PREFIX);
      setDismissed(null);
      moveCaret(MODEL_PREFIX.length);
    },
  });
  // Kept while the user goes elsewhere: back as it was when they return to this bot.
  const [text, setText] = useDraft(`chat.${bot.id}`);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [attached, setAttached] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // What a command just did ("Nova now uses …"), for a few seconds.
  const [done, setDone] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recorder, setRecorder] = useState<VoiceRecorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  const bots = useBots();
  const teams = useTeams();
  const working = bot.status === 'working';
  // Files and recordings land in the bot's workspace.
  const canAttach = bot.workspaceId !== null;
  const hasContent = text.trim().length > 0 || attached.length > 0;

  const trigger = triggerAt(
    text,
    caret,
    picked.map((p) => p.label),
  );
  const triggerKey = trigger && (trigger.kind === 'mention' ? `@${trigger.start}` : trigger.kind);
  const mentionQuery = trigger?.kind === 'mention' ? trigger.query : null;
  const providers = useProviders();
  const listings = useListings(providers.data ?? [], trigger?.kind === 'model');
  const models =
    trigger?.kind === 'model'
      ? modelGroups(providers.data ?? [], listings, bot, trigger.query)
      : [];
  const queryClient = useQueryClient();
  const setModel = useMutation({
    mutationFn: async (choice: ModelChoice) => {
      const { error } = await api.PATCH('/api/v1/bots/{id}', {
        params: { path: { id: bot.id } },
        body: { providerId: choice.providerId, model: choice.id },
      });
      if (error) throw error;
    },
    onMutate: () => {
      setNotice(null);
      setDone(null);
    },
    onSuccess: (_, choice) => {
      setDone(t('chat.model.set', { name: bot.name, model: choice.name ?? choice.id }));
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: () => setNotice(t('chat.model.failed')),
  });
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(null), 4000);
    return () => clearTimeout(timer);
  }, [done]);
  const fileQuery = useSettled(mentionQuery, 150);
  const files = useQuery({
    queryKey: ['file-search', bot.workspaceId, fileQuery],
    enabled: fileQuery !== null && bot.workspaceId !== null,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{id}/files/search', {
        params: {
          path: { id: bot.workspaceId as string },
          query: { q: fileQuery ?? '', limit: 6 },
        },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });

  const options = optionsFor(trigger);
  // `/model` stays open with nothing to pick yet: it says why (loading, no match…).
  const open =
    trigger !== null &&
    triggerKey !== dismissed &&
    (options.length > 0 || trigger.kind === 'model');

  function optionsFor(at: Trigger | null): Option[] {
    if (!at) return [];
    if (at.kind === 'command') {
      return commands
        .filter((command) => matches(at.query, command.name, t(`chat.commands.${command.name}`)))
        .map((command) => ({ key: `/${command.name}`, section: 'commands', command }));
    }
    if (at.kind === 'model') {
      return models.flatMap((group) =>
        group.models.map(
          (model): Option => ({
            key: `model:${model.providerId}:${model.id}`,
            section: 'models',
            model,
          }),
        ),
      );
    }
    const q = at.query;
    const out: Option[] = [
      ...(bots.data ?? [])
        .filter((other) => other.id !== bot.id && matches(q, other.name, other.role))
        .slice(0, 5)
        .map(
          (other): Option => ({
            key: `bot:${other.id}`,
            section: 'bots',
            picked: { kind: 'bot', id: other.id, label: other.name },
            icon: <BotAvatar seed={other.avatarSeed} size={22} />,
            hint: other.role,
          }),
        ),
      ...(teams.data ?? [])
        .filter((team) => matches(q, team.name))
        .slice(0, 4)
        .map(
          (team): Option => ({
            key: `team:${team.id}`,
            section: 'teams',
            picked: { kind: 'team', id: team.id, label: team.name },
            icon: <Users className="size-4" />,
            hint: t('chat.mentions.team'),
          }),
        ),
      ...projects
        .filter((project) => matches(q, project.name))
        .slice(0, 4)
        .map(
          (project): Option => ({
            key: `project:${project.id}`,
            section: 'projects',
            picked: { kind: 'project', id: project.id, label: project.name },
            icon: <FolderGit2 className="size-4" />,
            hint: t('chat.mentions.project'),
          }),
        ),
      ...(mentionQuery === fileQuery ? (files.data ?? []) : []).map(
        (entry): Option => ({
          key: `file:${entry.path}`,
          section: 'files',
          picked: { kind: 'file', path: entry.path, label: entry.path },
          icon:
            entry.type === 'directory' ? (
              <Folder className="size-4" />
            ) : (
              <File className="size-4" />
            ),
          hint: entry.type === 'directory' ? t('chat.mentions.folder') : t('chat.mentions.file'),
        }),
      ),
    ];
    return out;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: back to the first option when the list changes
  useEffect(() => setActive(0), [triggerKey, trigger?.query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const moveCaret = (at: number) =>
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
      setCaret(at);
    });

  const choose = (option: Option) => {
    if (option.section === 'commands') {
      setText('');
      setPicked([]);
      option.command.run();
      return;
    }
    if (option.section === 'models') {
      setText('');
      setPicked([]);
      if (!option.model.current) setModel.mutate(option.model);
      return;
    }
    if (trigger?.kind !== 'mention') return;
    const next = insertMention(text, trigger, option.picked.label);
    setText(next.text);
    setPicked((list) => [...list, option.picked]);
    moveCaret(next.caret);
  };

  const addFiles = (list: File[]) => {
    if (!canAttach || list.length === 0) return;
    setNotice(null);
    const room = MAX_ATTACHMENTS - attachedRef.current.length;
    const tooBig = list.find((file) => file.size > ATTACHMENT_MAX_BYTES);
    if (tooBig) {
      setNotice(
        t('chat.attach.tooBig', { name: tooBig.name, size: formatSize(ATTACHMENT_MAX_BYTES) }),
      );
    } else if (list.length > room) {
      setNotice(t('chat.attach.tooMany', { count: MAX_ATTACHMENTS }));
    }
    const added = list
      .filter((file) => file.size <= ATTACHMENT_MAX_BYTES)
      .slice(0, Math.max(0, room))
      .map((file) => ({
        id: crypto.randomUUID(),
        file,
        preview: IMAGE.test(file.name) ? URL.createObjectURL(file) : null,
      }));
    setAttached((current) => [...current, ...added]);
    area.current?.focus();
  };

  const removeFile = (id: string) => {
    forget(attached.filter((item) => item.id === id));
    setAttached((current) => current.filter((item) => item.id !== id));
  };

  // Thumbnails go with the composer.
  useEffect(() => () => forget(attachedRef.current), []);

  // Files dropped anywhere on the conversation.
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    if (!canAttach) return;
    // Entering a child leaves its parent: only the last leave ends the drag.
    let depth = 0;
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      addFilesRef.current([...(event.dataTransfer?.files ?? [])]);
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', drop);
    };
  }, [canAttach]);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0 || !canAttach) return;
    event.preventDefault();
    addFiles(pasted);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    const sending = attached;
    if (!value && sending.length === 0) return;
    // `/model gpt` picks the model that matches best, never goes to the bot.
    if (trigger?.kind === 'model' && sending.length === 0) {
      const best = options.find((option) => option.section === 'models');
      if (best) choose(best);
      else if (trigger.query.trim() && !models.some((group) => group.state === 'loading')) {
        setNotice(t('chat.model.none', { query: trigger.query.trim() }));
      }
      return;
    }
    // `/projet` is how a French speaker types `/project`.
    const typed = value.toLowerCase() === '/projet' ? '/project' : value;
    const command = sending.length === 0 && commands.find((c) => `/${c.name}` === typed);
    setText('');
    setPicked([]);
    setNotice(null);
    if (command) {
      command.run();
      return;
    }
    const mentions = mentionsToSend(value, picked);
    setAttached([]);
    onSend(
      value,
      mentions,
      sending.map((item) => item.file),
    ).then(
      () => forget(sending),
      () => {
        // Not sent: what was written comes back, unless something new was started.
        setText((current) => current || value);
        if (attachedRef.current.length === 0) {
          setPicked(picked);
          setAttached(sending);
        } else forget(sending);
      },
    );
  };

  const stopRecording = (recording: VoiceRecorder | null, send: boolean) => {
    setRecorder(null);
    setLevels([]);
    if (!recording) return;
    if (!send) {
      recording.cancel();
      return;
    }
    void recording.stop().then((result) => {
      if (result.durationMs >= MIN_RECORDING_MS) void onSendVoice(result).catch(() => {});
    });
  };

  const startRecording = async () => {
    setNotice(null);
    if (!canRecord()) {
      setNotice(t('chat.voice.unsupported'));
      return;
    }
    const recording = new VoiceRecorder();
    try {
      await recording.start((level) =>
        setLevels((current) => [...current.slice(1 - LIVE_BARS), level]),
      );
    } catch {
      recording.cancel();
      setNotice(t('chat.voice.micDenied'));
      return;
    }
    setElapsed(0);
    setRecorder(recording);
  };

  // The clock while recording; a recording that runs too long is sent as it is.
  const stopRef = useRef(stopRecording);
  stopRef.current = stopRecording;
  useEffect(() => {
    if (!recorder) return;
    const timer = window.setInterval(() => {
      setElapsed(recorder.elapsedMs);
      if (recorder.elapsedMs >= MAX_RECORDING_MS) stopRef.current(recorder, true);
    }, 200);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') stopRef.current(recorder, false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [recorder]);

  // Leaving the conversation drops a recording under way.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length > 0) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + options.length) % options.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        const option = options[active];
        if (option && !event.nativeEvent.isComposing) {
          event.preventDefault();
          choose(option);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(triggerKey);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  const follow = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  // The list over the field: the mentions by kind, or `/model`'s models by provider.
  const sections =
    trigger?.kind === 'model'
      ? models.map((group) => ({
          key: group.provider.id,
          title: group.provider.name,
          provider: group.provider,
          note: group.state === 'unreachable' ? t('chat.model.unreachable') : null,
          rows: options.filter(
            (o) => o.section === 'models' && o.model.providerId === group.provider.id,
          ),
          footer:
            group.state === 'loading' && group.models.length === 0
              ? t('chat.model.loading')
              : group.more > 0
                ? t('chat.model.more', { count: group.more })
                : null,
        }))
      : SECTIONS.map((section) => ({
          key: section,
          title: t(`chat.mentions.sections.${section}`),
          provider: null,
          note: null,
          rows: options.filter((o) => o.section === section),
          footer: null,
        })).filter((section) => section.rows.length > 0);
  const empty =
    trigger?.kind !== 'model' || models.length > 0
      ? null
      : providers.isPending
        ? t('chat.model.loading')
        : (providers.data ?? []).length === 0
          ? t('chat.model.noProvider')
          : trigger.query.trim()
            ? t('chat.model.none', { query: trigger.query.trim() })
            : t('chat.model.noModels');

  return (
    <div className="relative">
      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={springs.snappy}
            // Over the conversation: opaque, to stay readable.
            style={{ background: 'var(--card)' }}
            className="glass absolute inset-x-0 bottom-full z-30 mb-2 max-h-80 overflow-y-auto rounded-2xl p-1"
          >
            {sections.map((section) => (
              <div key={section.key} className="py-0.5">
                <p className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                  {section.provider && (
                    <ProviderMark
                      kind={section.provider.kind}
                      baseUrl={section.provider.baseUrl}
                      className="size-3"
                    />
                  )}
                  {section.title}
                  {section.note && (
                    <span className="normal-case tracking-normal"> · {section.note}</span>
                  )}
                </p>
                {section.rows.map((option) => {
                  const index = options.indexOf(option);
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setActive(index)}
                      // Keeps the focus (and the cursor) in the text field.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                      title={option.section === 'models' ? option.model.id : undefined}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-100',
                        index === active ? 'bg-ink/[0.08]' : 'hover:bg-ink/[0.04]',
                      )}
                    >
                      {option.section === 'commands' ? (
                        <>
                          <option.command.icon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="font-mono text-[13px]">/{option.command.name}</span>
                          <span className="min-w-0 truncate text-muted-foreground">
                            {t(`chat.commands.${option.command.name}`)}
                          </span>
                        </>
                      ) : option.section === 'models' ? (
                        <>
                          <span className="grid size-[22px] shrink-0 place-items-center text-muted-foreground">
                            {option.model.current ? (
                              <Check
                                className="size-4 text-primary"
                                aria-label={t('chat.model.current')}
                              />
                            ) : (
                              <Cpu className="size-4" />
                            )}
                          </span>
                          <span
                            className={cn(
                              'min-w-0 truncate',
                              !option.model.name && 'font-mono text-[13px]',
                            )}
                          >
                            {option.model.name ?? option.model.id}
                          </span>
                          {option.model.name && (
                            <span className="ml-auto min-w-0 max-w-[45%] shrink-0 truncate font-mono text-xs text-faint">
                              {option.model.id}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="grid size-[22px] shrink-0 place-items-center text-muted-foreground">
                            {option.icon}
                          </span>
                          <span
                            className={cn(
                              'min-w-0 truncate',
                              option.section === 'files' && 'font-mono text-[13px]',
                            )}
                          >
                            {option.picked.label}
                          </span>
                          <span className="ml-auto shrink-0 truncate text-xs text-faint">
                            {option.hint}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })}
                {section.footer && (
                  <p className="px-2.5 py-1.5 text-xs text-faint">{section.footer}</p>
                )}
              </div>
            ))}
            {empty && <p className="px-2.5 py-2 text-sm text-muted-foreground">{empty}</p>}
          </motion.div>
        )}
      </AnimatePresence>
      {notice && (
        <p role="alert" className="mb-2 px-1 text-sm text-destructive">
          {notice}
        </p>
      )}
      {done && !notice && (
        <p role="status" className="mb-2 px-1 text-sm text-muted-foreground">
          {done}
        </p>
      )}
      <div className="mb-1.5 flex px-1 empty:hidden">
        <ProjectChip bot={bot} open={projectMenu} onOpenChange={setProjectMenu} />
      </div>
      <form
        onSubmit={submit}
        className={cn('lens relative rounded-[26px] p-1.5', dragging && 'border-primary/50')}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[26px] border-2 border-dashed border-primary/60 bg-background/85 text-sm text-foreground">
            {t('chat.attach.drop')}
          </div>
        )}
        {attached.length > 0 && <PendingFiles files={attached} onRemove={removeFile} />}
        <div className="flex items-end gap-1.5">
          {canAttach && !recorder && (
            <>
              <Button
                variant="ghost"
                size="round"
                className="shrink-0"
                onClick={() => fileInput.current?.click()}
                aria-label={t('chat.attach.add')}
                title={t('chat.attach.add')}
              >
                <Paperclip className="size-4" />
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  addFiles([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
            </>
          )}
          {recorder ? (
            <>
              <RecordingBar elapsed={elapsed} levels={levels} />
              <Button
                variant="ghost"
                size="round"
                className="shrink-0"
                onClick={() => stopRecording(recorder, false)}
                aria-label={t('chat.voice.cancel')}
                title={t('chat.voice.cancel')}
              >
                <Trash2 className="size-4" />
              </Button>
              <Button
                size="round"
                className="shrink-0"
                onClick={() => stopRecording(recorder, true)}
                aria-label={t('chat.voice.send')}
              >
                <ArrowUp className="size-4" />
              </Button>
            </>
          ) : (
            <>
              <textarea
                ref={area}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  follow(event.target);
                }}
                onSelect={(event) => follow(event.currentTarget)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                onBlur={() => setDismissed(triggerKey)}
                onFocus={() => setDismissed(null)}
                rows={1}
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                placeholder={t('chat.placeholder', { name: bot.name })}
                className="max-h-[220px] min-h-10 min-w-0 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
              />
              {hasContent ? (
                <Button type="submit" size="round" className="shrink-0" aria-label={t('chat.send')}>
                  <ArrowUp className="size-4" />
                </Button>
              ) : working ? (
                <Button
                  type="button"
                  size="round"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => commands.find((c) => c.name === 'stop')?.run()}
                  aria-label={t('chat.stop')}
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : canAttach ? (
                <Button
                  size="round"
                  className="shrink-0"
                  onClick={() => void startRecording()}
                  aria-label={t('chat.voice.record')}
                  title={t('chat.voice.record')}
                >
                  <Mic className="size-4" />
                </Button>
              ) : (
                <Button type="submit" size="round" disabled aria-label={t('chat.send')}>
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
