import type { Message, ServerEvent } from '@mowbot/contract';

/** A bot's conversation as cached: oldest → newest, plus the cursor to load older messages. */
export interface Conversation {
  items: Message[];
  /** Pass as `before` to load older messages; null once the start is reached. */
  nextCursor: string | null;
}

export type DeltaEvent = Extract<ServerEvent, { type: 'message.delta' }>;

/** Replaces the message with the same id, or appends it (sent from elsewhere, or by a bot). */
export function upsertMessage(conversation: Conversation, message: Message): Conversation {
  const index = conversation.items.findIndex((m) => m.id === message.id);
  if (index < 0) return { ...conversation, items: [...conversation.items, message] };
  const items = conversation.items.slice();
  items[index] = message;
  return { ...conversation, items };
}

/** Streaming text appended to one part of a message. */
export function appendDelta(conversation: Conversation, event: DeltaEvent): Conversation {
  let changed = false;
  const items = conversation.items.map((message) => {
    if (message.id !== event.messageId) return message;
    changed = true;
    const parts = message.parts.slice();
    const part = parts[event.partIndex];
    parts[event.partIndex] =
      part && part.type === event.kind
        ? { ...part, text: part.text + event.text }
        : { type: event.kind, text: event.text };
    return { ...message, parts };
  });
  return changed ? { ...conversation, items } : conversation;
}

/** Older page loaded with `before`: goes in front, minus anything already there. */
export function prependOlder(conversation: Conversation, older: Conversation): Conversation {
  const known = new Set(conversation.items.map((m) => m.id));
  return {
    items: [...older.items.filter((m) => !known.has(m.id)), ...conversation.items],
    nextCursor: older.nextCursor,
  };
}

/**
 * A refetch of the latest page (reconnect, pull to refresh) keeps the older pages already
 * loaded, so scrolling back does not jump.
 */
export function mergeLatest(
  previous: Conversation | undefined,
  latest: Conversation,
): Conversation {
  const first = latest.items[0];
  if (!previous || !first) return latest;
  const older = previous.items.filter(
    (m) => m.createdAt < first.createdAt && !latest.items.some((l) => l.id === m.id),
  );
  if (older.length === 0) return latest;
  return { items: [...older, ...latest.items], nextCursor: previous.nextCursor };
}

/**
 * A card's button pressed in a message: the card shows the choice at once (before the hub
 * confirms). Anything but an unanswered card is left as it is.
 */
export function markPressed(
  conversation: Conversation,
  messageId: string,
  partIndex: number,
  label: string,
): Conversation {
  let changed = false;
  const items = conversation.items.map((message) => {
    const part = message.id === messageId ? message.parts[partIndex] : undefined;
    if (part?.type !== 'canvas' || part.content.kind !== 'card' || part.pressed !== null) {
      return message;
    }
    changed = true;
    const parts = message.parts.slice();
    parts[partIndex] = { ...part, pressed: label };
    return { ...message, parts };
  });
  return changed ? { ...conversation, items } : conversation;
}

/** The bot's answer being written right now, if any. */
export function liveMessage(conversation: Conversation | undefined): Message | undefined {
  const last = conversation?.items.at(-1);
  return last?.status === 'streaming' ? last : undefined;
}

/** Plain text of a message (incoming and user messages are text only). */
export function messageText(message: Pick<Message, 'parts'>): string {
  return message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** Sent by another bot, or a task notice, rather than typed by the user. */
export function isIncoming(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message.fromBotId !== null || message.fromName !== null || message.kind !== 'chat')
  );
}
