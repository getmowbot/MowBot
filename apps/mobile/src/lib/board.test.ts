import type { Canvas, CanvasContent, Notification, Question } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { bot, translator } from '../test/fixtures';
import {
  applyOrder,
  badgeText,
  cardButtonAction,
  cardButtonState,
  checklistProgress,
  dayGroup,
  dayPeriod,
  editChecklist,
  FILE_PREVIEW_HEIGHT,
  FRAME_HEIGHT,
  fileCanvasRoute,
  fileExtension,
  fileImageHeight,
  filePreview,
  firstName,
  foldedSummary,
  frameMayLoad,
  galleryThumbSize,
  groupByDay,
  htmlCanvasPage,
  IMAGE_HEIGHT,
  isWebImage,
  isWebLink,
  markRead,
  moveCanvas,
  NOTE_FOLD_HEIGHT,
  questionsOfBot,
  rangeTotal,
  replaceCanvas,
  scoreText,
  shownCanvases,
  statsColumns,
  textExcerpt,
  unreadCount,
  workingBots,
  workspaceFileUrl,
} from './board';

const at = (iso: string) => new Date(iso);

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

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

type FileCanvas = Extract<CanvasContent, { kind: 'file' }>;

function file(path: string, overrides: Partial<FileCanvas> = {}): FileCanvas {
  return {
    kind: 'file',
    path,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    type: 'file',
    size: 1200,
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
    expect(foldedSummary(score, fr)).toBe('PSG 2 – 0 OM');
    expect(foldedSummary({ kind: 'stats', items: [{ label: 'Articles', value: '42' }] }, fr)).toBe(
      'Articles : 42',
    );
    expect(foldedSummary({ kind: 'note', markdown: 'x' }, fr)).toBeNull();
  });

  it('keeps a card’s title, or a gallery’s count, when folded', () => {
    expect(foldedSummary({ kind: 'card', title: 'Kiprun KS900', buttons: [] }, fr)).toBe(
      'Kiprun KS900',
    );
    expect(
      foldedSummary(
        { kind: 'card', title: 'Kiprun', subtitle: '129 € · Decathlon', buttons: [] },
        fr,
      ),
    ).toBe('Kiprun · 129 € · Decathlon');
    const pictures = (count: number) =>
      ({
        kind: 'gallery',
        images: Array.from({ length: count }, (_, i) => ({ src: `${i}.png` })),
      }) as const;
    expect(foldedSummary(pictures(3), fr)).toBe('3 images');
    expect(foldedSummary(pictures(1), fr)).toBe('1 image');
    expect(foldedSummary(pictures(2), en)).toBe('2 images');
  });

  it('keeps a file’s name when folded', () => {
    expect(foldedSummary(file('outputs/rapport.md'), fr)).toBe('rapport.md');
    expect(foldedSummary(file('outputs', { type: 'directory' }), en)).toBe('outputs');
  });
});

describe('file canvases', () => {
  it('previews pictures and texts, not the rest', () => {
    expect(filePreview(file('a/photo.JPG', { size: 2_000_000 }))).toBe('image');
    expect(filePreview(file('a/huge.png', { size: 40 * 1024 ** 2 }))).toBeNull();
    expect(filePreview(file('rapport.md'))).toBe('markdown');
    expect(filePreview(file('data.csv'))).toBe('text');
    expect(filePreview(file('config.json'))).toBe('text');
    expect(filePreview(file('server.log', { size: 900 * 1024 ** 2 }))).toBe('text');
    expect(filePreview(file('empty.txt', { size: 0 }))).toBeNull();
    expect(filePreview(file('doc.pdf'))).toBeNull();
    expect(filePreview(file('table.xlsx'))).toBeNull();
    expect(filePreview(file('notes.md', { type: 'directory' }))).toBeNull();
  });

  it('sizes a picture to its proportions, within the frame', () => {
    expect(fileImageHeight(320, 16 / 9)).toBe(180);
    // Not loaded yet: 4:3.
    expect(fileImageHeight(320, null)).toBe(240);
    // Tall pictures stop at the frame's height.
    expect(fileImageHeight(320, 9 / 16)).toBe(FILE_PREVIEW_HEIGHT);
    expect(fileImageHeight(0, 1)).toBe(0);
  });

  it('names the extension', () => {
    expect(fileExtension('rapport.md')).toBe('MD');
    expect(fileExtension('archive.tar.gz')).toBe('GZ');
    expect(fileExtension('Makefile')).toBeNull();
    expect(fileExtension('.env')).toBeNull();
    expect(fileExtension('trailing.')).toBeNull();
    expect(fileExtension('weird.averylongext')).toBeNull();
  });

  it('reads the size of a file from a partial answer', () => {
    expect(rangeTotal('bytes 0-8191/52310')).toBe(52310);
    expect(rangeTotal('bytes */0')).toBe(0);
    expect(rangeTotal(null)).toBeNull();
    expect(rangeTotal('bytes 0-10/*')).toBeNull();
  });

  it('keeps the first lines of a text', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(textExcerpt(text, { lines: 3 })).toEqual({ text: 'line 1\nline 2\nline 3', more: true });
    expect(textExcerpt('a\r\nb\r\n\r\n', { lines: 2 })).toEqual({ text: 'a\nb', more: false });
    expect(textExcerpt('a\nb\n', { lines: 12 })).toEqual({ text: 'a\nb', more: false });
    // The last line of a cut text may stop mid-way: left out.
    expect(textExcerpt('a\nb\nhalf a li', { lines: 12, cut: true })).toEqual({
      text: 'a\nb',
      more: true,
    });
    // A text cut within its only line keeps it, without the broken character.
    const broken = String.fromCharCode(0xfffd);
    expect(textExcerpt(`{"a":1,"b":"${broken}`, { lines: 12, cut: true })).toEqual({
      text: '{"a":1,"b":"',
      more: true,
    });
    expect(textExcerpt('a\n\n\nb\nc', { lines: 3 })).toEqual({ text: 'a', more: true });
    // A byte order mark is not text.
    expect(textExcerpt(`${String.fromCharCode(0xfeff)}a`, { lines: 3 }).text).toBe('a');
  });

  it('drops the front matter of Markdown', () => {
    const doc = '---\ntitle: Rapport\ndate: 2026-10-21\n---\n# Rapport\n\nTexte.';
    expect(textExcerpt(doc, { lines: 12, markdown: true }).text).toBe('# Rapport\n\nTexte.');
    expect(textExcerpt(doc, { lines: 12 }).text).toContain('title: Rapport');
    expect(textExcerpt('---\n\nA rule above.', { lines: 12, markdown: true }).text).toBe(
      '---\n\nA rule above.',
    );
  });

  it('leads to the viewer, or the folder', () => {
    expect(fileCanvasRoute('ws-1', file('/outputs/rapport.md'))).toEqual({
      pathname: '/files/[workspaceId]/view',
      params: { workspaceId: 'ws-1', path: 'outputs/rapport.md' },
    });
    expect(fileCanvasRoute('ws-1', file('outputs/q3/', { type: 'directory' }))).toEqual({
      pathname: '/files/[workspaceId]',
      params: { workspaceId: 'ws-1', path: 'outputs/q3' },
    });
  });
});

describe('cards and galleries', () => {
  it('tells web pictures from workspace files', () => {
    expect(isWebImage('https://example.com/shoe.jpg')).toBe(true);
    expect(isWebImage('HTTP://example.com/a.png')).toBe(true);
    expect(isWebImage('outputs/shoe.jpg')).toBe(false);
    expect(isWebImage('data:image/png;base64,xx')).toBe(false);
  });

  it('only opens web pages', () => {
    expect(isWebLink('https://maps.google.com/?q=Paris')).toBe(true);
    expect(isWebLink('javascript:alert(1)')).toBe(false);
    expect(isWebLink('tel:0600000000')).toBe(false);
  });

  it('opens the page, answers the bot, or both', () => {
    const url = 'https://shop.example/kiprun';
    expect(cardButtonAction({ label: 'Voir', url })).toEqual({ open: url, answer: false });
    expect(cardButtonAction({ label: 'Acheter', url, reply: 'Je le prends' })).toEqual({
      open: url,
      answer: true,
    });
    expect(cardButtonAction({ label: 'Autre chose' })).toEqual({ open: null, answer: true });
    expect(cardButtonAction({ label: 'Bizarre', url: 'ftp://x' })).toEqual({
      open: null,
      answer: true,
    });
  });

  it('shows the first button as the key one, then the choice', () => {
    const see = { label: 'Voir', url: 'https://example.com' };
    const yes = { label: 'Oui', reply: 'Vas-y' };
    const no = { label: 'Non' };
    // On Home (never answered once and for all) and in a message not yet answered.
    for (const pressed of [undefined, null]) {
      expect(cardButtonState(yes, 0, pressed)).toEqual({
        primary: true,
        chosen: false,
        locked: false,
      });
      expect(cardButtonState(no, 1, pressed).primary).toBe(false);
    }
    // Answered: the choice stands out, the other answers are off, pages still open.
    expect(cardButtonState(yes, 0, 'Non')).toEqual({ primary: false, chosen: false, locked: true });
    expect(cardButtonState(no, 1, 'Non')).toEqual({ primary: true, chosen: true, locked: true });
    expect(cardButtonState(see, 2, 'Non')).toEqual({
      primary: false,
      chosen: false,
      locked: false,
    });
  });

  it('sizes gallery thumbnails to the row', () => {
    expect(galleryThumbSize(1, 320)).toBe(320);
    expect(galleryThumbSize(2, 320)).toBe(155);
    // Three or more: the next one peeks out, within bounds.
    expect(galleryThumbSize(3, 320)).toBe(125);
    expect(galleryThumbSize(6, 200)).toBe(112);
    expect(galleryThumbSize(6, 800)).toBe(160);
    expect(galleryThumbSize(3, 0)).toBe(0);
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

  it('badges the tab with the unread count', () => {
    expect(badgeText(0)).toBeUndefined();
    expect(badgeText(3)).toBe('3');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(250)).toBe('99+');
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
