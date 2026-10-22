import type { Bot, Message, MessageKind } from '@mowbot/contract';

/**
 * Sent by another bot, a task notice or a routine, rather than typed by the user in the chat.
 * The hub's own « go on » after the step limit is neither: a line of its own.
 */
export function isIncoming(message: Message): boolean {
  return (
    message.role === 'user' &&
    !message.resume &&
    (message.fromBotId !== null || message.fromName !== null || message.kind !== 'chat')
  );
}

/**
 * Messages as the bot read them: one that reached it while it worked shows above the answer it
 * was taken into (that answer started first, but goes on knowing it).
 */
export function inReadingOrder(messages: Message[]): Message[] {
  const ids = new Set(messages.map((m) => m.id));
  const into = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.steeredInto && ids.has(message.steeredInto)) {
      into.set(message.steeredInto, [...(into.get(message.steeredInto) ?? []), message]);
    }
  }
  if (into.size === 0) return messages;
  return messages.flatMap((message) =>
    message.steeredInto && ids.has(message.steeredInto)
      ? []
      : [...(into.get(message.id) ?? []), message],
  );
}

/** Who wrote an incoming message: a bot (named, even once deleted), the user (a task), or the hub (a routine). */
export type Sender =
  | { kind: 'bot'; id: string | null; name: string }
  | { kind: 'user' }
  | { kind: 'hub' };

export function senderOf(message: Message): Sender {
  if (message.fromBotId || message.fromName) {
    return { kind: 'bot', id: message.fromBotId, name: message.fromName ?? '' };
  }
  return message.kind === 'routine' ? { kind: 'hub' } : { kind: 'user' };
}

const senderKey = (sender: Sender) =>
  sender.kind === 'bot' ? `bot:${sender.id ?? sender.name}` : sender.kind;

/** Where an incoming message sits among the incoming messages around it. */
export interface IncomingPlace {
  /** On a run's first message: the whole run, whose senders and kinds it names. */
  run: Message[] | null;
}

/**
 * Consecutive incoming messages stay close: bots' messages together (each a line naming its
 * sender), the user's or the hub's only with their own, under one line saying who sent them.
 */
export function incomingPlaces(messages: Message[]): Map<string, IncomingPlace> {
  const places = new Map<string, IncomingPlace>();
  let run: Message[] = [];
  const close = () => {
    run.forEach((m, i) => {
      places.set(m.id, { run: i === 0 ? run : null });
    });
    run = [];
  };
  for (const message of messages) {
    if (!isIncoming(message)) {
      close();
      continue;
    }
    const last = run.at(-1);
    if (last) {
      const [a, b] = [senderOf(last), senderOf(message)];
      if (!(a.kind === 'bot' && b.kind === 'bot') && senderKey(a) !== senderKey(b)) close();
    }
    run.push(message);
  }
  close();
  return places;
}

/** Who sent a run, once each in order (the hub aside), and what it holds (plain messages aside). */
export function runSummary(run: Message[]): { senders: Sender[]; kinds: MessageKind[] } {
  const senders = new Map<string, Sender>();
  for (const message of run) {
    const sender = senderOf(message);
    if (sender.kind !== 'hub' && !senders.has(senderKey(sender))) {
      senders.set(senderKey(sender), sender);
    }
  }
  const kinds = [...new Set(run.map((m) => m.kind))].filter((kind) => kind !== 'chat');
  return { senders: [...senders.values()], kinds };
}

/** A bot as a chip in a line: `name` is also the text that stands for it. Deleted bots have no id. */
export interface ChipBot {
  id: string | null;
  name: string;
  avatarSeed: string;
  isChef?: boolean;
}

/** The bots a message's text may name: every bot, what it mentions, and its sender if deleted. */
export function chipBots(bots: Bot[] | undefined, message: Message): ChipBot[] {
  const list: ChipBot[] = (bots ?? []).map(({ id, name, avatarSeed, isChef }) => ({
    id,
    name,
    avatarSeed,
    isChef,
  }));
  for (const mention of message.mentions) {
    const bot = mention.kind === 'bot' ? bots?.find((b) => b.id === mention.id) : undefined;
    if (bot && mention.label !== bot.name) {
      list.push({
        id: bot.id,
        name: mention.label,
        avatarSeed: bot.avatarSeed,
        isChef: bot.isChef,
      });
    }
  }
  if (message.fromName && !list.some((b) => b.id === message.fromBotId)) {
    list.push({ id: null, name: message.fromName, avatarSeed: message.fromName });
  }
  return list;
}

const WORD = /[\p{L}\p{N}_]/u;

/** `text` cut around the names it holds as whole words, an @ before one going with it. */
export function nameSegments<T extends { name: string }>(
  text: string,
  refs: T[],
): { text: string; ref?: T }[] {
  // Longest first: "Nova Prime" before "Nova".
  const sorted = refs.filter((r) => r.name.trim()).sort((a, b) => b.name.length - a.name.length);
  if (sorted.length === 0) return [{ text }];
  const out: { text: string; ref?: T }[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const start = text[i] === '@' ? i + 1 : i;
    const found =
      i === 0 || !WORD.test(text[i - 1] ?? '')
        ? sorted.find(
            (r) => text.startsWith(r.name, start) && !WORD.test(text[start + r.name.length] ?? ''),
          )
        : undefined;
    if (found) {
      if (plain) out.push({ text: plain });
      plain = '';
      const end = start + found.name.length;
      out.push({ text: text.slice(i, end), ref: found });
      i = end;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}

const SENTENCE = /^.*?[.!?…](?=\s|$)/;
const SUMMARY_MAX = 140;

/**
 * A text in a few words, for a folded message: its first sentence, markdown aside (with the
 * next one when the first is only a greeting), cut when long.
 */
export function shortSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let summary = SENTENCE.exec(plain)?.[0] ?? plain;
  if (summary.split(' ').length <= 3 && summary.length < plain.length) {
    const next = SENTENCE.exec(plain.slice(summary.length).trimStart())?.[0];
    summary = next ? `${summary} ${next}` : plain;
  }
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary;
}

/** A message from another bot in a few words: what its sender wrote for it, or its first sentence. */
export function summaryOf(message: Message): string {
  const written = message.summary?.trim();
  if (written) return written;
  return shortSummary(message.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
}
