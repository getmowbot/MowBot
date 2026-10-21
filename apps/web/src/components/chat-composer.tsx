import type { Bot, Mention } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowRightLeft,
  ArrowUp,
  Blocks,
  Eraser,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  KeyRound,
  type LucideIcon,
  Monitor,
  Pencil,
  Repeat,
  Settings2,
  Square,
  Users,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
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
import { projectsFor, useProjects } from '../lib/projects';
import { useBots, useTeams } from '../lib/queries';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { useClearConversation } from './bot-menu';
import { useOrgDialogs } from './org-dialogs';
import { ProjectChip } from './project-chip';
import { Button } from './ui/button';

/** A `/` command of the composer: done in the app, never sent to the bot. */
type CommandName =
  | 'stop'
  | 'clear'
  | 'project'
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
  actions: { togglePc(): void; rename(): void; pickProject: (() => void) | null },
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
  | {
      key: string;
      section: 'bots' | 'teams' | 'projects' | 'files';
      picked: Picked;
      icon: ReactNode;
      hint: string;
    };

const SECTIONS = ['commands', 'bots', 'teams', 'projects', 'files'] as const;

/** The message field: `/` runs a command, `@` points at a bot, a team, a project or a file. */
export function ChatComposer({
  bot,
  onTogglePc,
  onRename,
  onSend,
}: {
  bot: Bot;
  onTogglePc(): void;
  onRename(): void;
  onSend(text: string, mentions: Mention[]): void;
}) {
  const { t } = useTranslation();
  // The project the bot works in: a chip over the field, `/project` opens its menu.
  const [projectMenu, setProjectMenu] = useState(false);
  const projects = projectsFor(bot, useProjects().data);
  const commands = useChatCommands(bot, {
    togglePc: onTogglePc,
    rename: onRename,
    pickProject: projects.length > 0 ? () => setProjectMenu(true) : null,
  });
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const bots = useBots();
  const teams = useTeams();
  const working = bot.status === 'working';

  const trigger = triggerAt(
    text,
    caret,
    picked.map((p) => p.label),
  );
  const triggerKey = trigger && (trigger.kind === 'command' ? 'command' : `@${trigger.start}`);
  const mentionQuery = trigger?.kind === 'mention' ? trigger.query : null;
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
  const open = trigger !== null && triggerKey !== dismissed && options.length > 0;

  function optionsFor(at: Trigger | null): Option[] {
    if (!at) return [];
    if (at.kind === 'command') {
      return commands
        .filter((command) => matches(at.query, command.name, t(`chat.commands.${command.name}`)))
        .map((command) => ({ key: `/${command.name}`, section: 'commands', command }));
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
    if (trigger?.kind !== 'mention') return;
    const next = insertMention(text, trigger, option.picked.label);
    setText(next.text);
    setPicked((list) => [...list, option.picked]);
    moveCaret(next.caret);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value) return;
    // `/projet` is how a French speaker types `/project`.
    const typed = value.toLowerCase() === '/projet' ? '/project' : value;
    const command = commands.find((c) => `/${c.name}` === typed);
    if (command) command.run();
    else onSend(value, mentionsToSend(value, picked));
    setText('');
    setPicked([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
            {SECTIONS.map((section) => {
              const rows = options.filter((o) => o.section === section);
              if (rows.length === 0) return null;
              return (
                <div key={section} className="py-0.5">
                  <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
                    {t(`chat.mentions.sections.${section}`)}
                  </p>
                  {rows.map((option) => {
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
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-100',
                          index === active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]',
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
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mb-1.5 flex px-1 empty:hidden">
        <ProjectChip bot={bot} open={projectMenu} onOpenChange={setProjectMenu} />
      </div>
      <form
        onSubmit={submit}
        className="glass flex items-end gap-2 rounded-2xl p-2 transition-[border-color] duration-300 focus-within:border-white/30"
      >
        <textarea
          ref={area}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            follow(event.target);
          }}
          onSelect={(event) => follow(event.currentTarget)}
          onKeyDown={onKeyDown}
          onBlur={() => setDismissed(triggerKey)}
          onFocus={() => setDismissed(null)}
          rows={1}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={t('chat.placeholder', { name: bot.name })}
          className="max-h-[220px] min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
        />
        {working ? (
          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => commands.find((c) => c.name === 'stop')?.run()}
            aria-label={t('chat.stop')}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!text.trim()} aria-label={t('chat.send')}>
            <ArrowUp className="size-4" />
          </Button>
        )}
      </form>
    </div>
  );
}
