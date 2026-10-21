import type { Bot, Mention, MessageMention } from '@mowbot/contract';

/** For matching: lower case, without accents. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Whether `query` appears in one of `fields`, case and accents aside. Not trimmed: once a name is
 * written in full, the space typed after it stops matching (and closes the picker).
 */
export function matches(query: string, ...fields: string[]): boolean {
  const needle = fold(query);
  return fields.some((field) => fold(field).includes(needle));
}

/** What `/` offers in a conversation, in this order. Names are the same in every language. */
export const COMMANDS = [
  'stop',
  'clear',
  'project',
  'pc',
  'files',
  'settings',
  'mcp',
  'vault',
  'routines',
] as const;
export type CommandName = (typeof COMMANDS)[number];

/**
 * The commands a bot has: `/project` needs projects it may use, `/pc` its PC, `/files` its
 * workspace.
 */
export function botCommands(
  bot: Pick<Bot, 'computerId' | 'workspaceId'>,
  hasProjects = false,
): CommandName[] {
  return COMMANDS.filter((name) => {
    if (name === 'project') return hasProjects;
    if (name === 'pc') return Boolean(bot.computerId);
    if (name === 'files') return Boolean(bot.workspaceId);
    return true;
  });
}

/** Commands whose name or title contains the query, names starting with it first. */
export function filterCommands<C extends { name: string; title: string }>(
  commands: readonly C[],
  query: string,
): C[] {
  const needle = fold(query.trim());
  const rank = (command: C) =>
    fold(command.name).startsWith(needle) ? 0 : fold(command.title).startsWith(needle) ? 1 : 2;
  return commands
    .filter((command) => matches(needle, command.name, command.title))
    .sort((a, b) => rank(a) - rank(b));
}

/** Other spellings of a command: `/projet` is how a French speaker types `/project`. */
export const COMMAND_ALIASES: Readonly<Record<string, CommandName>> = { projet: 'project' };

/** The command a sent text is exactly (`/stop`); null for anything else, sent as a message. */
export function commandOf<N extends string>(text: string, names: readonly N[]): N | null {
  const typed = /^\/(\S+)$/.exec(text.trim())?.[1]?.toLowerCase();
  const name = typed && (COMMAND_ALIASES[typed] ?? typed);
  return names.find((candidate) => candidate === name) ?? null;
}

/** Past this many characters after an @, the user is writing, not looking for a name. */
const MAX_MENTION_QUERY = 60;

/** What the user is typing: a command (`/sto`), or a mention up to the cursor (`@No`). */
export type Trigger =
  | { kind: 'command'; query: string }
  | { kind: 'mention'; query: string; start: number; end: number };
export type MentionTrigger = Extract<Trigger, { kind: 'mention' }>;

export function triggerAt(text: string, caret: number): Trigger | null {
  if (/^\/\S*$/.test(text)) return { kind: 'command', query: text.slice(1) };
  const end = Math.min(Math.max(caret, 0), text.length);
  const before = text.slice(0, end);
  const at = before.lastIndexOf('@');
  // At the start or after a space: an address (me@site.com) is no mention.
  if (at === -1 || (at > 0 && !/\s/.test(before.charAt(at - 1)))) return null;
  const query = before.slice(at + 1);
  // Names have spaces ("Équipe principale"); a line break ends the mention.
  if (/[\r\n]/.test(query) || /^\s/.test(query) || query.length > MAX_MENTION_QUERY) return null;
  return { kind: 'mention', query, start: at, end };
}

/** How many of each kind the picker shows. */
export const MENTION_LIMIT = 5;

/** Up to `limit` items whose label contains the query, those starting with it first. */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
  limit = MENTION_LIMIT,
): T[] {
  const needle = fold(query);
  const rank = (item: T) => (fold(label(item)).startsWith(needle) ? 0 : 1);
  return items
    .filter((item) => matches(query, label(item)))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/**
 * Whether the picker stays open: something matches, or the query has no space yet. A space is
 * allowed while it still matches ("@Équipe p"), not after a name written in full ("@Nova merci").
 */
export function pickerOpen(query: string, found: number): boolean {
  return found > 0 || !/\s/.test(query);
}

/**
 * The text with the typed `@query` replaced by `@label ` (no second space when one follows), and
 * where the cursor goes: past that space.
 */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  label: string,
): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const inserted = /^\s/.test(after) ? `@${label}` : `@${label} `;
  return {
    text: text.slice(0, trigger.start) + inserted + after,
    caret: trigger.start + label.length + 2,
  };
}

const mentionKey = (mention: Mention) =>
  mention.kind === 'file' ? `file:${mention.path}` : `${mention.kind}:${mention.id}`;

/** The picked mentions still written in the text, once each, without their label (the hub's). */
export function mentionsToSend(text: string, picked: readonly MessageMention[]): Mention[] {
  const seen = new Set<string>();
  const kept: Mention[] = [];
  for (const { label, ...mention } of picked) {
    const key = mentionKey(mention);
    if (seen.has(key) || !text.includes(`@${label}`)) continue;
    seen.add(key);
    kept.push(mention);
  }
  return kept;
}

export interface TextSegment {
  text: string;
  mention?: MessageMention;
}

/** A message's text cut around its mentions, to show each `@label` highlighted. */
export function mentionSegments(text: string, mentions: readonly MessageMention[]): TextSegment[] {
  if (mentions.length === 0) return [{ text }];
  // Longest first: "@Équipe principale" before a bot named "Équipe".
  const labels = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const segments: TextSegment[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const found =
      text[i] === '@'
        ? labels.find((m) => m.label && text.startsWith(`@${m.label}`, i))
        : undefined;
    if (found) {
      if (plain) segments.push({ text: plain });
      plain = '';
      segments.push({ text: `@${found.label}`, mention: found });
      i += found.label.length + 1;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) segments.push({ text: plain });
  return segments;
}
