import type { BotActivity } from '@mowbot/contract';

/** Longest string of a tool's input that reaches the apps. */
export const ACTIVITY_TEXT_MAX = 120;

/**
 * The fields of a tool's input the apps word an action with ("Lance npm", "Écrit à Sacha · …",
 * "Ouvre github.com"). Short scalars only: never what a call writes or sends (`content`, `text`,
 * `question`…) nor what may hold a secret (`env`, `headers`, `password`, `value`…).
 */
const LABEL_FIELDS = new Set([
  'intent',
  'summary',
  'action',
  'to',
  'bot',
  'team',
  'name',
  'title',
  'status',
  'url',
  'path',
  'command',
  'query',
  'pattern',
  'project',
  'server',
  'tool',
  'automation',
  'service',
  'kind',
  'key',
  'keys',
  'ref',
  'option',
  'direction',
  'x',
  'y',
  'to_x',
  'to_y',
  'minutes',
]);

/** Tools of MCP servers: their inputs follow schemas the hub does not know. */
const MCP_TOOL = /^mcp__/;

function clip(text: string): string {
  return text.length > ACTIVITY_TEXT_MAX
    ? `${text.slice(0, ACTIVITY_TEXT_MAX - 1).trimEnd()}…`
    : text;
}

/** A page's address without what may authenticate it: no user, password or query (but a search's `q`). */
function bareUrl(text: string): string {
  try {
    const url = new URL(text);
    const q = url.searchParams.get('q');
    return `${url.protocol}//${url.host}${url.pathname}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  } catch {
    return text;
  }
}

/** What of a tool call's input the apps may see while it runs. */
export function activityInput(toolName: string, input: unknown): BotActivity['input'] {
  if (MCP_TOOL.test(toolName) || !input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const kept: BotActivity['input'] = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LABEL_FIELDS.has(key)) continue;
    if (typeof value === 'string') kept[key] = clip(key === 'url' ? bareUrl(value) : value);
    else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value;
    else if (typeof value === 'boolean') kept[key] = value;
  }
  return kept;
}

/**
 * What each working bot is doing right now: the tool calls it runs, in memory only. Several can
 * run at once; the last one started is the one shown. `changed` hears every change of a bot's
 * current activity.
 */
export class BotActivities {
  private readonly calls = new Map<string, Map<string, BotActivity>>();

  constructor(private readonly changed: (botId: string) => void) {}

  of(botId: string): BotActivity | null {
    const running = this.calls.get(botId);
    return running ? ([...running.values()].at(-1) ?? null) : null;
  }

  start(botId: string, callId: string, activity: BotActivity): void {
    let running = this.calls.get(botId);
    if (!running) {
      running = new Map();
      this.calls.set(botId, running);
    }
    running.delete(callId);
    running.set(callId, activity);
    this.changed(botId);
  }

  end(botId: string, callId: string): void {
    const running = this.calls.get(botId);
    if (!running?.delete(callId)) return;
    if (running.size === 0) this.calls.delete(botId);
    this.changed(botId);
  }

  /** The run is over: nothing it started counts any more. */
  clear(botId: string): void {
    if (this.calls.delete(botId)) this.changed(botId);
  }
}
