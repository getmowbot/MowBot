import type { Canvas, CanvasContent, Notification, Question } from '@mowbot/contract';
import { describe, expect, it } from 'vitest';
import { bot } from '../test/fixtures';
import {
  applyOrder,
  checklistProgress,
  dayGroup,
  dayPeriod,
  editChecklist,
  FRAME_HEIGHT,
  firstName,
  foldedSummary,
  frameMayLoad,
  groupByDay,
  htmlCanvasPage,
  IMAGE_HEIGHT,
  markRead,
  moveCanvas,
  NOTE_FOLD_HEIGHT,
  questionsOfBot,
  replaceCanvas,
  scoreText,
  shownCanvases,
  statsColumns,
  unreadCount,
  workingBots,
  workspaceFileUrl,
} from './board';

const at = (iso: string) => new Date(iso);

function canvas(id: string, overrides: Partial<Canvas> = {}): Canvas {
  return {
    id,
    botId: 'bot-1',
    key: id,
    title: id.toUpperCase(),
    size: 'm',
    content: { kind: 'note', markdown: 'hi' },
    position: 0,
    hidden: false,
    collapsed: false,
    updatedAt: '2026-10-20T10:00:00.000Z',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function notification(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id,
    botId: null,
    priority: 'normal',
    title: id,
    body: null,
    readAt: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

function question(id: string, overrides: Partial<Question> = {}): Question {
  return {
    id,
    botId: 'bot-1',
    question: '?',
    options: [],
    status: 'open',
    answer: null,
    answeredAt: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('greeting', () => {
  it('follows the time of day', () => {
    expect(dayPeriod(4)).toBe('evening');
    expect(dayPeriod(5)).toBe('morning');
    expect(dayPeriod(11)).toBe('morning');
    expect(dayPeriod(12)).toBe('afternoon');
    expect(dayPeriod(17)).toBe('afternoon');
    expect(dayPeriod(18)).toBe('evening');
    expect(dayPeriod(23)).toBe('evening');
  });

  it('uses the first name', () => {
    expect(firstName('Joris Levasseur')).toBe('Joris');
    expect(firstName('  Ana  ')).toBe('Ana');
    expect(firstName('')).toBe('');
    expect(firstName(undefined)).toBe('');
  });

  it('counts the bots at work', () => {
    const bots = [
      bot({ status: 'working' }),
      bot({ status: 'waiting_bot' }),
      bot({ status: 'waiting_user' }),
      bot({ status: 'idle' }),
    ];
    expect(workingBots(bots)).toHaveLength(2);
    expect(workingBots(undefined)).toEqual([]);
  });
});

describe('canvases', () => {
  const all = [
    canvas('a', { position: 0 }),
    canvas('b', { position: 1, hidden: true }),
    canvas('c', { position: 2 }),
    canvas('d', { position: 3 }),
  ];

  it('hides removed cards unless asked', () => {
    expect(shownCanvases(all, false).map((c) => c.id)).toEqual(['a', 'c', 'd']);
    expect(shownCanvases(all, true)).toHaveLength(4);
  });

  it('moves a card past its visible neighbour', () => {
    const shown = ['a', 'c', 'd'];
    expect(moveCanvas(all, shown, 'c', -1)).toEqual(['c', 'b', 'a', 'd']);
    expect(moveCanvas(all, shown, 'c', 1)).toEqual(['a', 'b', 'd', 'c']);
    expect(moveCanvas(all, shown, 'a', -1)).toBeNull();
    expect(moveCanvas(all, shown, 'd', 1)).toBeNull();
    expect(moveCanvas(all, shown, 'x', 1)).toBeNull();
  });

  it('applies a new order and renumbers positions', () => {
    const ordered = applyOrder(all, ['d', 'a', 'b', 'c']);
    expect(ordered.map((c) => [c.id, c.position])).toEqual([
      ['d', 0],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('replaces a canvas in the cache', () => {
    const next = replaceCanvas(all, { ...canvas('c'), title: 'New' });
    expect(next?.find((c) => c.id === 'c')?.title).toBe('New');
    expect(replaceCanvas(undefined, canvas('c'))).toBeUndefined();
  });

  it('maps sizes to heights', () => {
    for (const map of [FRAME_HEIGHT, IMAGE_HEIGHT, NOTE_FOLD_HEIGHT]) {
      expect(map.s).toBeLessThan(map.m);
      expect(map.m).toBeLessThan(map.l);
    }
    expect(FRAME_HEIGHT).toEqual({ s: 200, m: 260, l: 360 });
  });

  it('lays stats out in tidy rows', () => {
    expect(statsColumns(1, 320)).toBe(1);
    expect(statsColumns(3, 320)).toBe(3);
    expect(statsColumns(3, 260)).toBe(2);
    expect(statsColumns(4, 320)).toBe(2);
    expect(statsColumns(5, 320)).toBe(3);
    expect(statsColumns(6, 260)).toBe(2);
    expect(statsColumns(0, 320)).toBe(1);
  });

  it('shows a score once both sides have one', () => {
    const score: Extract<CanvasContent, { kind: 'score' }> = {
      kind: 'score',
      home: { name: 'PSG' },
      away: { name: 'OM' },
      homeScore: 2,
      awayScore: 0,
      status: 'Terminé',
    };
    expect(scoreText(score)).toBe('2 – 0');
    expect(scoreText({ ...score, awayScore: null })).toBe('–');
    // Folded, a card keeps one line: the score, the first figure, or nothing.
    expect(foldedSummary(score)).toBe('PSG 2 – 0 OM');
    expect(foldedSummary({ kind: 'stats', items: [{ label: 'Articles', value: '42' }] })).toBe(
      'Articles : 42',
    );
    expect(foldedSummary({ kind: 'note', markdown: 'x' })).toBeNull();
  });
});

describe('checklists', () => {
  const list = canvas('list', {
    content: {
      kind: 'checklist',
      items: [
        { id: '1', text: 'Milk', done: true },
        { id: '2', text: 'Eggs', done: false },
      ],
    },
  });

  it('edits the items', () => {
    const ticked = editChecklist(list, (items) =>
      items.map((i) => (i.id === '2' ? { ...i, done: true } : i)),
    );
    expect(checklistProgress(ticked.content)).toEqual({ done: 2, total: 2 });
    const removed = editChecklist(list, (items) => items.filter((i) => i.id !== '1'));
    expect(checklistProgress(removed.content)).toEqual({ done: 0, total: 1 });
  });

  it('leaves other kinds alone', () => {
    const note = canvas('note');
    expect(editChecklist(note, () => [])).toBe(note);
    expect(checklistProgress(note.content)).toBeNull();
    expect(checklistProgress({ kind: 'checklist', items: [] })).toBeNull();
  });
});

describe('html canvases', () => {
  it('wraps the page in a locked-down document', () => {
    const page = htmlCanvasPage('<p>Hi</p><meta http-equiv="refresh" content="0;url=https://x">');
    expect(page).toContain("default-src 'none'");
    expect(page).toContain('<p>Hi</p>');
    expect(page).not.toContain('refresh');
    expect(page).toContain('width=device-width');
  });

  it('never navigates away', () => {
    expect(frameMayLoad('about:blank')).toBe(true);
    expect(frameMayLoad('https://example.com')).toBe(false);
    expect(frameMayLoad('http://192.168.1.2:8787/')).toBe(false);
  });
});

describe('workspace images', () => {
  it('builds the file content URL', () => {
    expect(workspaceFileUrl('http://10.0.0.2:8787/', 'ws-1', 'logos/psg club.png')).toBe(
      'http://10.0.0.2:8787/api/v1/workspaces/ws-1/files/content?path=logos%2Fpsg%20club.png',
    );
  });
});

describe('questions', () => {
  it('lists a bot’s open questions, oldest first', () => {
    const list = [
      question('new', { createdAt: '2026-10-20T12:00:00.000Z' }),
      question('other-bot', { botId: 'bot-2' }),
      question('answered', { status: 'answered' }),
      question('old', { createdAt: '2026-10-20T08:00:00.000Z' }),
    ];
    expect(questionsOfBot(list, 'bot-1').map((q) => q.id)).toEqual(['old', 'new']);
    expect(questionsOfBot(undefined, 'bot-1')).toEqual([]);
  });
});

describe('notifications', () => {
  const items = [
    notification('a'),
    notification('b', { priority: 'urgent' }),
    notification('c', { priority: 'digest' }),
    notification('d', { readAt: '2026-10-20T11:00:00.000Z' }),
  ];

  it('counts unread like the hub (digests left out)', () => {
    expect(unreadCount(items)).toBe(2);
  });

  it('marks some or all read', () => {
    const now = at('2026-10-20T12:00:00.000Z');
    const some = markRead({ items, unread: 2 }, ['a'], now);
    expect(some.unread).toBe(1);
    expect(some.items[0]?.readAt).toBe(now.toISOString());
    expect(some.items[3]?.readAt).toBe('2026-10-20T11:00:00.000Z');
    const all = markRead({ items, unread: 2 }, undefined, now);
    expect(all.unread).toBe(0);
    expect(all.items.every((n) => n.readAt)).toBe(true);
  });

  it('groups by day', () => {
    const now = new Date(2026, 9, 20, 15, 0);
    const today = new Date(2026, 9, 20, 9, 0).toISOString();
    const yesterday = new Date(2026, 9, 19, 23, 30).toISOString();
    const older = new Date(2026, 9, 12, 9, 0).toISOString();
    expect(dayGroup(today, now)).toBe('today');
    expect(dayGroup(yesterday, now)).toBe('yesterday');
    expect(dayGroup(older, now)).toBe('earlier');
    const groups = groupByDay(
      [
        notification('1', { createdAt: today }),
        notification('2', { createdAt: yesterday }),
        notification('3', { createdAt: older }),
        notification('4', { createdAt: older }),
      ],
      now,
    );
    expect(groups.map((g) => [g.day, g.items.length])).toEqual([
      ['today', 1],
      ['yesterday', 1],
      ['earlier', 2],
    ]);
  });
});
