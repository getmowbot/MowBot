import { describe, expect, it } from 'vitest';
import { bot, message } from '../test/fixtures';
import {
  chipBots,
  incomingPlaces,
  inReadingOrder,
  nameSegments,
  runSummary,
  shortSummary,
  summaryOf,
} from './incoming';

const fromBot = (id: string, name: string, kind: 'chat' | 'ask' | 'task' = 'chat') =>
  message({ role: 'user', fromBotId: id, fromName: name, kind });

describe('incoming runs', () => {
  it('keeps bot messages together, up to the next answer', () => {
    const a = fromBot('b-1', 'Nova', 'task');
    const b = fromBot('b-2', 'Iris');
    const answer = message();
    const c = fromBot('b-1', 'Nova');
    const places = incomingPlaces([a, b, answer, c]);
    expect(places.get(a.id)).toEqual({ run: [a, b] });
    expect(places.get(b.id)).toEqual({ run: null });
    expect(places.has(answer.id)).toBe(false);
    expect(places.get(c.id)).toEqual({ run: [c] });
  });

  it('keeps the user’s and the hub’s messages with their own', () => {
    const typed = message({ role: 'user' });
    const task = message({ role: 'user', kind: 'task' });
    const routine = message({ role: 'user', kind: 'routine' });
    const other = message({ role: 'user', kind: 'routine' });
    const places = incomingPlaces([typed, task, routine, other]);
    expect(places.has(typed.id)).toBe(false);
    expect(places.get(task.id)?.run).toEqual([task]);
    expect(places.get(routine.id)).toEqual({ run: [routine, other] });
  });

  it('names each sender once, the hub aside, and the kinds that are not plain messages', () => {
    const run = [
      fromBot('b-1', 'Nova', 'task'),
      fromBot('b-2', 'Iris', 'ask'),
      fromBot('b-1', 'Nova', 'task'),
    ];
    expect(runSummary(run)).toEqual({
      senders: [
        { kind: 'bot', id: 'b-1', name: 'Nova' },
        { kind: 'bot', id: 'b-2', name: 'Iris' },
      ],
      kinds: ['task', 'ask'],
    });
    expect(runSummary([message({ role: 'user', kind: 'routine' })])).toEqual({
      senders: [],
      kinds: ['routine'],
    });
  });
});

describe('bot names in a text', () => {
  const refs = [{ name: 'Nova' }, { name: 'Nova Prime' }, { name: 'Chef' }];

  it('cuts whole names, the longest first, with their @', () => {
    expect(nameSegments('Nova Prime a vu @Chef, pas Novak.', refs)).toEqual([
      { text: 'Nova Prime', ref: refs[1] },
      { text: ' a vu ' },
      { text: '@Chef', ref: refs[2] },
      { text: ', pas Novak.' },
    ]);
  });

  it('leaves a name inside a word, or written in lower case', () => {
    expect(nameSegments('SuperNova et le chef', refs)).toEqual([{ text: 'SuperNova et le chef' }]);
  });

  it('chips every bot, mention labels and a deleted sender', () => {
    const nova = bot({ id: 'b-1', name: 'Nova', avatarSeed: 'n' });
    const said = message({
      role: 'user',
      fromBotId: null,
      fromName: 'Ancien',
      mentions: [{ kind: 'bot', id: 'b-1', label: 'Novette' }],
    });
    expect(chipBots([nova], said)).toEqual([
      { id: 'b-1', name: 'Nova', avatarSeed: 'n', isChef: false },
      { id: 'b-1', name: 'Novette', avatarSeed: 'n', isChef: false },
      { id: null, name: 'Ancien', avatarSeed: 'Ancien' },
    ]);
  });
});

describe('reading order', () => {
  it('puts what reached a bot while it worked above the answer it went into', () => {
    const asked = message({ role: 'user' });
    const answer = message();
    const late = fromBot('b-1', 'Nova');
    const during = message({ role: 'user', steered: true, steeredInto: answer.id });
    const after = message({ role: 'user' });
    expect(inReadingOrder([asked, answer, during, late, after])).toEqual([
      asked,
      during,
      answer,
      late,
      after,
    ]);
  });

  it('leaves a message whose answer is not loaded where it is', () => {
    const lost = message({ role: 'user', steered: true, steeredInto: 'elsewhere' });
    const list = [message(), lost];
    expect(inReadingOrder(list)).toBe(list);
  });
});

describe('a bot message in a few words', () => {
  const text = (value: string) => [{ type: 'text' as const, text: value }];

  it('keeps the summary its sender wrote', () => {
    const written = message({ role: 'user', summary: ' La playlist est prête ', parts: text('…') });
    expect(summaryOf(written)).toBe('La playlist est prête');
  });

  it('takes the first sentence, markdown aside', () => {
    expect(shortSummary('## Bilan\n**3 offres** trouvées. Détails dans [le fichier](x.md).')).toBe(
      'Bilan 3 offres trouvées.',
    );
    expect(summaryOf(message({ role: 'user', parts: text('Pas de point final') }))).toBe(
      'Pas de point final',
    );
  });

  it('goes past a greeting', () => {
    expect(shortSummary('Salut Hans ! Peux-tu lancer la playlist ? Merci.')).toBe(
      'Salut Hans ! Peux-tu lancer la playlist ?',
    );
  });

  it('cuts a long sentence', () => {
    const summary = shortSummary(`${'mot '.repeat(60)}fin.`);
    expect(summary.length).toBe(140);
    expect(summary.endsWith('…')).toBe(true);
  });
});
