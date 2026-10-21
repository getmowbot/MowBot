import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { message } from '../test/fixtures';
import { applyServerEvent } from './event-cache';
import {
  appendDelta,
  type Conversation,
  isIncoming,
  liveMessage,
  markPressed,
  mergeLatest,
  prependOlder,
  upsertMessage,
} from './message-cache';
import { keys } from './query-keys';

describe('conversation cache', () => {
  it('upserts by id', () => {
    const first = message({ status: 'streaming' });
    const conversation: Conversation = { items: [first], nextCursor: null };
    const done = { ...first, status: 'done' as const };
    expect(upsertMessage(conversation, done).items).toEqual([done]);
    const next = message();
    expect(upsertMessage(conversation, next).items).toEqual([first, next]);
  });

  it('appends streamed text to the right part', () => {
    const streaming = message({ status: 'streaming', parts: [{ type: 'text', text: 'Bon' }] });
    const conversation: Conversation = { items: [streaming], nextCursor: null };
    const event = {
      type: 'message.delta' as const,
      botId: streaming.botId,
      messageId: streaming.id,
      partIndex: 0,
      kind: 'text' as const,
      text: 'jour',
    };
    expect(appendDelta(conversation, event).items[0]?.parts).toEqual([
      { type: 'text', text: 'Bonjour' },
    ]);
    // A new part (e.g. reasoning after a tool call) starts fresh.
    const reasoning = appendDelta(conversation, { ...event, partIndex: 1, kind: 'reasoning' });
    expect(reasoning.items[0]?.parts[1]).toEqual({ type: 'reasoning', text: 'jour' });
    // Unknown message: same object, nothing re-renders.
    expect(appendDelta(conversation, { ...event, messageId: 'other' })).toBe(conversation);
  });

  it('puts older pages in front and keeps them across a refetch of the latest page', () => {
    const [a, b, c, d] = [message(), message(), message(), message()];
    if (!a || !b || !c || !d) throw new Error('fixtures');
    const latest: Conversation = { items: [c, d], nextCursor: c.createdAt };
    const withOlder = prependOlder(latest, { items: [a, b], nextCursor: null });
    expect(withOlder.items.map((m) => m.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(withOlder.nextCursor).toBeNull();

    const e = message();
    const refetched = mergeLatest(withOlder, { items: [d, e], nextCursor: d.createdAt });
    expect(refetched.items.map((m) => m.id)).toEqual([a.id, b.id, c.id, d.id, e.id]);
    expect(refetched.nextCursor).toBeNull();
  });

  it('tells incoming messages from the user’s own', () => {
    expect(isIncoming(message({ role: 'user' }))).toBe(false);
    expect(isIncoming(message({ role: 'user', fromBotId: 'x', fromName: 'Nova' }))).toBe(true);
    expect(isIncoming(message({ role: 'user', kind: 'task' }))).toBe(true);
    expect(
      liveMessage({ items: [message({ status: 'streaming' })], nextCursor: null }),
    ).toBeDefined();
  });

  it('shows a card’s choice at once, only once', () => {
    const card = {
      type: 'canvas' as const,
      content: { kind: 'card' as const, title: 'Pizza ?', buttons: [{ label: 'Oui' }] },
      pressed: null,
    };
    const score = {
      type: 'canvas' as const,
      content: { kind: 'stats' as const, items: [{ label: 'Buts', value: '2' }] },
      pressed: null,
    };
    const answer = message({ parts: [{ type: 'text', text: 'Alors ?' }, card, score] });
    const conversation: Conversation = { items: [message(), answer], nextCursor: null };

    const pressed = markPressed(conversation, answer.id, 1, 'Oui');
    expect(pressed.items[1]?.parts[1]).toEqual({ ...card, pressed: 'Oui' });
    expect(pressed.items[0]).toBe(conversation.items[0]);
    // Already answered, not a card, no such part or message: unchanged.
    expect(markPressed(pressed, answer.id, 1, 'Non')).toBe(pressed);
    expect(markPressed(conversation, answer.id, 2, 'Oui')).toBe(conversation);
    expect(markPressed(conversation, answer.id, 0, 'Oui')).toBe(conversation);
    expect(markPressed(conversation, answer.id, 9, 'Oui')).toBe(conversation);
    expect(markPressed(conversation, 'other', 1, 'Oui')).toBe(conversation);
  });
});

describe('server events', () => {
  it('streams into a loaded conversation and tracks the live answer', () => {
    const client = new QueryClient();
    const answer = message({ status: 'streaming', parts: [] });
    client.setQueryData<Conversation>(keys.messages(answer.botId), { items: [], nextCursor: null });

    applyServerEvent(client, { type: 'message.updated', message: answer });
    applyServerEvent(client, {
      type: 'message.delta',
      botId: answer.botId,
      messageId: answer.id,
      partIndex: 0,
      kind: 'text',
      text: 'Salut',
    });
    expect(client.getQueryData<Conversation>(keys.messages(answer.botId))?.items[0]?.parts).toEqual(
      [{ type: 'text', text: 'Salut' }],
    );
    expect(client.getQueryData(keys.live(answer.botId))).toEqual(answer);

    applyServerEvent(client, { type: 'message.updated', message: { ...answer, status: 'done' } });
    expect(client.getQueryData(keys.live(answer.botId))).toBeNull();

    applyServerEvent(client, { type: 'messages.cleared', botId: answer.botId });
    expect(client.getQueryData<Conversation>(keys.messages(answer.botId))?.items).toEqual([]);
  });
});
