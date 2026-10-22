import type { BotActivity, MessagePart, TaskStatus } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { shortSummary } from './incoming';

export type ToolPart = Extract<MessagePart, { type: 'tool' }>;
export type ReasoningPart = Extract<MessagePart, { type: 'reasoning' }>;
/** A card, pictures, a score… the bot shows inside its answer. */
export type CanvasPart = Extract<MessagePart, { type: 'canvas' }>;
/** A login or a secret the bot asks for: a form answered straight into the vault. */
export type VaultRequestPart = Extract<MessagePart, { type: 'vault_request' }>;
/** The bot needs the user to take control of its PC: a card with a button to do it. */
export type TakeoverRequestPart = Extract<MessagePart, { type: 'takeover_request' }>;
/** What a bot does between two things it says: tool calls and reasoning. */
export type ActivityPart = ToolPart | ReasoningPart;

/** Icon names, mapped to glyphs by the UI. */
export type ActivityIcon =
  | 'terminal'
  | 'file'
  | 'file-pen'
  | 'folder'
  | 'search'
  | 'globe'
  | 'camera'
  | 'pointer'
  | 'window'
  | 'tidy'
  | 'monitor'
  | 'lock'
  | 'unlock'
  | 'users'
  | 'send'
  | 'question'
  | 'task-new'
  | 'tasks'
  | 'user-new'
  | 'user-edit'
  | 'tool'
  | 'brain'
  | 'check';

type Input = Record<string, unknown>;

/** The tool a bot shows things in the conversation with: once done, what it showed says it all. */
export const SHOW_IN_CHAT = 'show_in_chat';

const str = (value: unknown) => (typeof value === 'string' ? value : '');

const workspacePath = (value: unknown) => str(value).replace(/^\/workspace\/?/, '') || 'workspace';

/** A place in a project of the user's computer: the path, or the project itself. */
const projectPath = (input: Input) => str(input.path) || str(input.project) || '.';

/** `Tape « … »`, or `Tape du texte` without the text (what a bot is doing leaves it out). */
function typing(value: unknown, t: TFunction): string {
  const text = str(value).slice(0, 60);
  return text ? t('activity.tool.type', { text }) : t('activity.tool.typeAny');
}

/** `Écrit à Nova · La playlist est prête`: the gist the bot gave (or the first sentence). */
function withGist(who: string, input: Input, text: unknown): string {
  const gist = str(input.summary).trim() || shortSummary(str(text));
  return gist ? `${who} · ${gist}` : who;
}

/** A message or a question to another bot: opens large rather than unfolding. */
export const isTalk = (part: ToolPart) =>
  part.toolName === 'send_message' || part.toolName === 'ask_bot';

/** The hub's words before a question's answer, in the tool's output. */
const ANSWER_PREFIX = /^Réponse de [^\n]*:\n/;

/**
 * What a talk step holds: who it went to, what was said, and what came back (a question's
 * answer, or why it failed).
 */
export function talkOf(part: ToolPart): {
  to: string;
  asks: boolean;
  text: string;
  answer: { text: string; fromBot: boolean } | null;
} {
  const i = (part.input ?? {}) as Input;
  const asks = part.toolName === 'ask_bot';
  const output = part.state === 'running' ? '' : (part.output ?? '');
  return {
    to: str(i.to).trim(),
    asks,
    text: str(asks ? i.question : i.text),
    answer:
      output && (asks || part.state === 'error')
        ? { text: output.replace(ANSWER_PREFIX, ''), fromBot: ANSWER_PREFIX.test(output) }
        : null,
  };
}

const SEARCH_HOST =
  /(^|\.)(google\.[a-z.]+|duckduckgo\.com|bing\.com|qwant\.com|search\.brave\.com)$/;

/** `https://www.google.com/search?q=mowbot` → `mowbot` (parsed by hand: no URL API needed). */
export function searchQuery(value: unknown): string | null {
  const match = str(value).match(/^https?:\/\/([^/?#]+)[^?#]*\?([^#]*)/i);
  if (!match?.[1] || !SEARCH_HOST.test(match[1].toLowerCase())) return null;
  for (const pair of (match[2] ?? '').split('&')) {
    const [key, raw = ''] = pair.split('=');
    if (key !== 'q') continue;
    try {
      return decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      return raw;
    }
  }
  return null;
}

function hostOf(value: unknown): string | null {
  const host = str(value).match(/^[a-z][a-z\d+.-]*:\/\/([^/?#:]+)/i)?.[1];
  return host ? host.replace(/^www\./, '') : null;
}

function describeUrl(value: unknown, t: TFunction): string {
  const query = searchQuery(value);
  if (query) return t('activity.tool.search', { query });
  return t('activity.tool.open', { target: hostOf(value) ?? str(value) });
}

/** `cd /tmp && curl -sL …` → `Lance curl`. */
function describeCommand(value: unknown, t: TFunction): string {
  const step = str(value)
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^(cd|export|set)\b/.test(s));
  const program = step
    ?.replace(/^(sudo|nohup|env|time)\s+/, '')
    .split(/\s+/)[0]
    ?.split('/')
    .at(-1);
  return program ? t('activity.tool.runProgram', { program }) : t('activity.tool.runCommand');
}

function describeComputer(input: Input, t: TFunction): string {
  const at = typeof input.x === 'number' ? ` (${input.x}, ${input.y})` : '';
  switch (input.action) {
    case 'click':
      return t('activity.tool.click', { at });
    case 'double_click':
      return t('activity.tool.doubleClick', { at });
    case 'right_click':
      return t('activity.tool.rightClick', { at });
    case 'move':
      return t('activity.tool.move', { at });
    case 'type':
      return typing(input.text, t);
    case 'key':
      return t('activity.tool.key', { keys: str(input.keys) });
    case 'scroll':
      return input.direction === 'up' ? t('activity.tool.scrollUp') : t('activity.tool.scrollDown');
    case 'drag':
      return t('activity.tool.drag', { at, x: input.to_x, y: input.to_y });
    default:
      return t('activity.tool.screenAction');
  }
}

/** Categories counted in the summary of a finished activity. */
export type ActivityKind =
  | 'search'
  | 'page'
  | 'capture'
  | 'command'
  | 'screen'
  | 'write'
  | 'read'
  | 'tidy'
  | 'message'
  | 'question'
  | 'task'
  | 'created';

const TASK_STATUSES = new Set<TaskStatus>(['todo', 'doing', 'blocked', 'done', 'cancelled']);

interface ToolMeta {
  icon(input: Input): ActivityIcon;
  title(input: Input, t: TFunction): string;
  kind(input: Input): ActivityKind | null;
}

const openPage: ToolMeta = {
  icon: (i) => (searchQuery(i.url) ? 'search' : 'globe'),
  title: (i, t) => describeUrl(i.url, t),
  kind: (i) => (searchQuery(i.url) ? 'search' : 'page'),
};

/** A tool of an MCP server (`mcp__github__create_issue`, or through mcp_call). */
const mcpTool: ToolMeta = {
  icon: () => 'tool',
  title: (i, t) =>
    str(i.server) && str(i.tool)
      ? t('activity.tool.mcpTool', { server: str(i.server), tool: str(i.tool) })
      : '',
  kind: () => null,
};

const TOOLS: Record<string, ToolMeta> = {
  bash: {
    icon: () => 'terminal',
    title: (i, t) => describeCommand(i.command, t),
    kind: () => 'command',
  },
  read_file: {
    icon: () => 'file',
    title: (i, t) => t('activity.tool.read', { path: workspacePath(i.path) }),
    kind: () => 'read',
  },
  write_file: {
    icon: () => 'file-pen',
    title: (i, t) => t('activity.tool.write', { path: workspacePath(i.path) }),
    kind: () => 'write',
  },
  list_files: {
    icon: () => 'folder',
    title: (i, t) => t('activity.tool.list', { path: workspacePath(i.path) }),
    kind: () => 'read',
  },
  browser_open: openPage,
  // Conversations from before the bots had their own browser window.
  open_url: openPage,
  browser_snapshot: {
    icon: () => 'file',
    title: (_, t) => t('activity.tool.browserRead'),
    kind: () => null,
  },
  browser_click: {
    icon: () => 'pointer',
    title: (_, t) => t('activity.tool.browserClick'),
    kind: () => null,
  },
  browser_type: {
    icon: () => 'pointer',
    title: (i, t) => typing(i.text, t),
    kind: () => null,
  },
  browser_select: {
    icon: () => 'pointer',
    title: (i, t) => t('activity.tool.browserSelect', { option: str(i.option) }),
    kind: () => null,
  },
  browser_press: {
    icon: () => 'pointer',
    title: (i, t) => t('activity.tool.key', { keys: str(i.key) }),
    kind: () => null,
  },
  browser_scroll: {
    icon: () => 'pointer',
    title: (i, t) =>
      i.direction === 'up' ? t('activity.tool.scrollUp') : t('activity.tool.scrollDown'),
    kind: () => null,
  },
  browser_back: {
    icon: () => 'globe',
    title: (_, t) => t('activity.tool.browserBack'),
    kind: () => null,
  },
  browser_screenshot: {
    icon: () => 'camera',
    title: (_, t) => t('activity.tool.browserScreenshot'),
    kind: () => 'capture',
  },
  screenshot: {
    icon: () => 'camera',
    title: (_, t) => t('activity.tool.screenshot'),
    kind: () => 'capture',
  },
  computer: { icon: () => 'pointer', title: describeComputer, kind: () => 'screen' },
  list_windows: {
    icon: () => 'window',
    title: (_, t) => t('activity.tool.listWindows'),
    kind: () => null,
  },
  close_windows: {
    icon: () => 'tidy',
    title: (i, t) =>
      Array.isArray(i.ids) && i.ids.length > 0
        ? t('activity.tool.closeWindows', { count: i.ids.length })
        : t('activity.tool.tidy'),
    kind: () => 'tidy',
  },
  pc_status: {
    icon: () => 'monitor',
    title: (_, t) => t('activity.tool.pcStatus'),
    kind: () => null,
  },
  lock_file: {
    icon: () => 'lock',
    title: (i, t) => t('activity.tool.lock', { path: workspacePath(i.path) }),
    kind: () => null,
  },
  unlock_file: {
    icon: () => 'unlock',
    title: (i, t) => t('activity.tool.unlock', { path: workspacePath(i.path) }),
    kind: () => null,
  },
  list_bots: {
    icon: () => 'users',
    title: (_, t) => t('activity.tool.listBots'),
    kind: () => null,
  },
  send_message: {
    icon: () => 'send',
    title: (i, t) => withGist(t('activity.tool.sendMessage', { to: str(i.to) }), i, i.text),
    kind: () => 'message',
  },
  ask_bot: {
    icon: () => 'question',
    title: (i, t) => withGist(t('activity.tool.askBot', { to: str(i.to) }), i, i.question),
    kind: () => 'question',
  },
  assign_task: {
    icon: () => 'task-new',
    title: (i, t) => t('activity.tool.assignTask', { title: str(i.title), to: str(i.to) }),
    kind: () => 'task',
  },
  update_task: {
    icon: () => 'tasks',
    title: (i, t) => {
      const status = str(i.status) as TaskStatus;
      return TASK_STATUSES.has(status)
        ? t('activity.tool.updateTask', { status: t(`tasks.status.${status}`) })
        : t('activity.tool.updateTaskGeneric');
    },
    kind: () => null,
  },
  list_tasks: {
    icon: () => 'tasks',
    title: (_, t) => t('activity.tool.listTasks'),
    kind: () => null,
  },
  plan_set: {
    icon: () => 'tasks',
    title: (_, t) => t('activity.tool.planSet'),
    kind: () => null,
  },
  plan_update: {
    icon: () => 'tasks',
    title: (_, t) => t('activity.tool.planUpdate'),
    kind: () => null,
  },
  plan_show: {
    icon: () => 'tasks',
    title: (_, t) => t('activity.tool.planShow'),
    kind: () => null,
  },
  create_team: {
    icon: () => 'users',
    title: (i, t) => t('activity.tool.createTeam', { name: str(i.name) }),
    kind: () => 'created',
  },
  create_bot: {
    icon: () => 'user-new',
    title: (i, t) => t('activity.tool.createBot', { name: str(i.name) }),
    kind: () => 'created',
  },
  update_bot: {
    icon: () => 'user-edit',
    title: (i, t) => t('activity.tool.updateBot', { name: str(i.bot) }),
    kind: () => null,
  },
  [SHOW_IN_CHAT]: {
    icon: () => 'window',
    title: (_, t) => t('activity.tool.showInChat'),
    kind: () => null,
  },
  set_focus: {
    icon: () => 'user-edit',
    title: (i, t) =>
      str(i.text).trim()
        ? t('activity.tool.setFocus', { text: str(i.text).trim() })
        : t('activity.tool.clearFocus'),
    kind: () => null,
  },
  stop_bot: {
    icon: () => 'user-edit',
    title: (i, t) => t('activity.tool.stopBot', { name: str(i.bot) }),
    kind: () => null,
  },
  request_takeover: {
    icon: () => 'monitor',
    title: (_, t) => t('activity.tool.requestTakeover'),
    kind: () => 'question',
  },
  vault_request: {
    icon: () => 'lock',
    title: (i, t) => t('activity.tool.vaultRequest', { service: str(i.service) }),
    kind: () => 'question',
  },
  mcp_call: mcpTool,
  mcp_search_tools: {
    icon: () => 'search',
    title: (_, t) => t('activity.tool.mcpSearch'),
    kind: () => null,
  },
  // Projects: folders of the user's own computer.
  local_exec: {
    icon: () => 'terminal',
    title: (i, t) => describeCommand(i.command, t),
    kind: () => 'command',
  },
  local_read: {
    icon: () => 'file',
    title: (i, t) => t('activity.tool.read', { path: projectPath(i) }),
    kind: () => 'read',
  },
  local_write: {
    icon: () => 'file-pen',
    title: (i, t) => t('activity.tool.write', { path: projectPath(i) }),
    kind: () => 'write',
  },
  local_edit: {
    icon: () => 'file-pen',
    title: (i, t) => t('activity.tool.edit', { path: projectPath(i) }),
    kind: () => 'write',
  },
  local_list: {
    icon: () => 'folder',
    title: (i, t) => t('activity.tool.list', { path: projectPath(i) }),
    kind: () => 'read',
  },
  local_find: {
    icon: () => 'search',
    title: (i, t) => t('activity.tool.findFiles', { pattern: str(i.pattern) }),
    kind: () => 'read',
  },
  local_search: {
    icon: () => 'search',
    title: (i, t) => t('activity.tool.search', { query: str(i.pattern) }),
    kind: () => 'read',
  },
  local_pull: {
    icon: () => 'folder',
    title: (i, t) => t('activity.tool.pullProject', { project: str(i.project) || '…' }),
    kind: () => null,
  },
  local_push: {
    icon: () => 'folder',
    title: (i, t) => t('activity.tool.pushProject', { project: str(i.project) || '…' }),
    kind: () => null,
  },
  local_projects: {
    icon: () => 'folder',
    title: (_, t) => t('activity.tool.listProjects'),
    kind: () => null,
  },
  local_use_project: {
    icon: () => 'folder',
    title: (i, t) => t('activity.tool.useProject', { project: str(i.project) }),
    kind: () => null,
  },
};

const FALLBACK: ToolMeta = { icon: () => 'tool', title: () => '', kind: () => null };

/** `mcp__github__create_issue`: a tool of an MCP server, called directly. */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

/** How a call is worded, and its input as the wording reads it (MCP tools: server and tool). */
function metaOf(toolName: string, raw: unknown): [ToolMeta, Input] {
  const given = (raw ?? {}) as Input;
  const direct = MCP_TOOL.exec(toolName);
  if (direct) return [mcpTool, { ...given, server: direct[1], tool: direct[2] }];
  return [TOOLS[toolName] ?? FALLBACK, given];
}

export function toolIcon(part: ToolPart): ActivityIcon {
  const [meta, i] = metaOf(part.toolName, part.input);
  return meta.icon(i);
}

/**
 * A tool call in a few words: what the bot says it is doing (`intent`), or a label derived
 * from the call ("Lance npm", "Écrit à Sacha · …", "Ouvre github.com").
 */
export function actionTitle(
  { toolName, input: raw }: Pick<BotActivity, 'toolName'> & { input: unknown },
  t: TFunction,
): string {
  const [meta, i] = metaOf(toolName, raw);
  const intent = str(i.intent).trim();
  if (intent) return intent;
  return meta.title(i, t) || toolName;
}

/** What the bot says it is doing (`intent`), or a label derived from the call. */
export const toolTitle = (part: ToolPart, t: TFunction) => actionTitle(part, t);

/** With an intent as title, the mechanical label (click coordinates…) goes into the details. */
export function toolMechanics(part: ToolPart, t: TFunction): string {
  const [meta, i] = metaOf(part.toolName, part.input);
  return str(i.intent).trim() ? meta.title(i, t) : '';
}

/** `2 recherches · 1 page · 5 captures` */
export function summarize(tools: ToolPart[], t: TFunction): string {
  const counts = new Map<ActivityKind, number>();
  for (const part of tools) {
    const [meta, i] = metaOf(part.toolName, part.input);
    const kind = meta.kind(i);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  if (counts.size === 0) return t('activity.actions', { count: tools.length });
  return [...counts].map(([kind, count]) => t(`activity.count.${kind}`, { count })).join(' · ');
}

export interface ActivityHeadline {
  title: string;
  icon: ActivityIcon;
  errors: number;
}

/** One line for a run of actions: what the bot does right now while live, a summary once done. */
export function activityHeadline(
  parts: ActivityPart[],
  live: boolean,
  t: TFunction,
): ActivityHeadline {
  const tools = parts.filter((p): p is ToolPart => p.type === 'tool');
  const running = tools.findLast((p) => p.state === 'running');
  const errors = tools.filter((p) => p.state === 'error').length;
  if (live) {
    return running
      ? { title: toolTitle(running, t), icon: toolIcon(running), errors }
      : { title: t('activity.thinking'), icon: 'brain', errors };
  }
  return tools.length > 0
    ? { title: summarize(tools, t), icon: 'check', errors }
    : { title: t('activity.reasoning'), icon: 'brain', errors };
}

/** Steps worth listing when the line is opened (empty reasoning is skipped). */
export function activitySteps(parts: ActivityPart[]): ActivityPart[] {
  return parts.filter((p) => p.type === 'tool' || p.text.trim());
}

export type Segment =
  | { kind: 'text'; text: string; index: number }
  | { kind: 'activity'; parts: ActivityPart[]; index: number }
  | { kind: 'canvas'; part: CanvasPart; index: number }
  | { kind: 'vault'; part: VaultRequestPart; index: number }
  | { kind: 'takeover'; part: TakeoverRequestPart; index: number };

/**
 * Text stays as is; the tool calls and reasoning between two texts become one activity; what
 * the bot shows (a card, pictures…) and the forms it asks with stand where they came, its
 * finished show_in_chat call left out. `index` is the part's position in the message (a
 * card's buttons and a form answer by it).
 */
export function segments(parts: MessagePart[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim()) out.push({ kind: 'text', text: part.text, index });
      return;
    }
    if (part.type === 'canvas') {
      out.push({ kind: 'canvas', part, index });
      return;
    }
    if (part.type === 'vault_request') {
      out.push({ kind: 'vault', part, index });
      return;
    }
    if (part.type === 'takeover_request') {
      out.push({ kind: 'takeover', part, index });
      return;
    }
    if (part.type === 'tool' && part.toolName === SHOW_IN_CHAT && part.state === 'done') return;
    // What the user sends (files, voice); never in an answer.
    if (part.type === 'attachment' || part.type === 'audio') return;
    const tail = out.at(-1);
    if (tail?.kind === 'activity') tail.parts.push(part);
    else out.push({ kind: 'activity', parts: [part], index });
  });
  return out;
}
