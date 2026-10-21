import type { Bot, Message, MessageKind } from '@mowbot/contract';

/** Sent by another bot, a task notice or a routine, rather than typed by the user in the chat. */
export function isIncoming(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message.fromBotId !== null || message.fromName !== null || message.kind !== 'chat')
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
  /** The run has several senders: each message names its own. */
  mixed: boolean;
}

/**
 * Consecutive incoming messages share one line saying who sent them: bots' messages together,
 * the user's or the hub's only with their own.
 */
export function incomingPlaces(messages: Message[]): Map<string, IncomingPlace> {
  const places = new Map<string, IncomingPlace>();
  let run: Message[] = [];
  const close = () => {
    const mixed = new Set(run.map((m) => senderKey(senderOf(m)))).size > 1;
    run.forEach((m, i) => {
      places.set(m.id, { run: i === 0 ? run : null, mixed });
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

/** The text opened by `@name`, which shows as the sender's chip: inline, or above a list or a heading. */
export function withSender(name: string, text: string): string {
  return /^\s*([#>|]|```|[-*+]\s|\d+[.)]\s)/.test(text)
    ? `@${name}\n\n${text}`
    : `@${name} ${text}`;
}
