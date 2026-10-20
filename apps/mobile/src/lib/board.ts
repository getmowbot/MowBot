import type {
  Bot,
  Canvas,
  CanvasContent,
  CanvasSize,
  Notification,
  Question,
} from '@mowbot/contract';

/**
 * Pure logic of the Home tab (no React, no native modules): greeting, canvases order and
 * layout, checklist and notification cache changes, the sandboxed page of `html` canvases.
 */

export type DayPeriod = 'morning' | 'afternoon' | 'evening';

/** Morning from 5 h, afternoon from 12 h, evening from 18 h (and through the night). */
export function dayPeriod(hour: number): DayPeriod {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** "Joris Levasseur" → "Joris": the greeting stays short enough for a large title. */
export function firstName(displayName: string | null | undefined): string {
  return displayName?.trim().split(/\s+/)[0] ?? '';
}

/** Bots busy right now (working, or waiting for another bot's answer as part of their work). */
export function workingBots(bots: readonly Bot[] | undefined): Bot[] {
  return (bots ?? []).filter((b) => b.status === 'working' || b.status === 'waiting_bot');
}

// ---------------------------------------------------------------------------------------------
// Canvases

export const CANVAS_SIZES: readonly CanvasSize[] = ['s', 'm', 'l'];

/** Height of an `html` canvas's frame (same as the web's). */
export const FRAME_HEIGHT: Record<CanvasSize, number> = { s: 200, m: 260, l: 360 };
/** Height of a note's picture. */
export const IMAGE_HEIGHT: Record<CanvasSize, number> = { s: 140, m: 180, l: 240 };
/** A note taller than this is folded ("show more"); large notes unfold further. */
export const NOTE_FOLD_HEIGHT: Record<CanvasSize, number> = { s: 150, m: 240, l: 420 };

export function shownCanvases(all: readonly Canvas[], showHidden: boolean): Canvas[] {
  return all.filter((c) => showHidden || !c.hidden);
}

/**
 * New order of every canvas (hidden ones included) after moving one up (-1) or down (1) past
 * its neighbour among the cards on screen; null when it cannot move that way.
 */
export function moveCanvas(
  all: readonly Canvas[],
  shownIds: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] | null {
  const at = shownIds.indexOf(id);
  const neighbour = shownIds[at + direction];
  if (at < 0 || neighbour === undefined) return null;
  const ids = all.map((c) => c.id);
  const from = ids.indexOf(id);
  const to = ids.indexOf(neighbour);
  if (from < 0 || to < 0) return null;
  ids[from] = neighbour;
  ids[to] = id;
  return ids;
}

/** The cached list in a new order (positions renumbered like the hub does). */
export function applyOrder(list: readonly Canvas[], ids: readonly string[]): Canvas[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...list]
    .sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length))
    .map((canvas, position) => ({ ...canvas, position }));
}

export function replaceCanvas(list: readonly Canvas[] | undefined, canvas: Canvas) {
  return list?.map((c) => (c.id === canvas.id ? canvas : c));
}

type Checklist = Extract<CanvasContent, { kind: 'checklist' }>;

/** Changes the items of a checklist canvas (other kinds are left as they are). */
export function editChecklist(
  canvas: Canvas,
  change: (items: Checklist['items']) => Checklist['items'],
): Canvas {
  if (canvas.content.kind !== 'checklist') return canvas;
  return { ...canvas, content: { ...canvas.content, items: change(canvas.content.items) } };
}

export function checklistProgress(content: CanvasContent): { done: number; total: number } | null {
  if (content.kind !== 'checklist' || content.items.length === 0) return null;
  return { done: content.items.filter((i) => i.done).length, total: content.items.length };
}

/** Columns of a stats card: everything on one row when it fits, never a lone straggler of 4. */
export function statsColumns(count: number, width: number): number {
  const fit = width >= 300 ? 3 : 2;
  if (count <= fit) return Math.max(1, count);
  if (count === 4) return 2;
  return fit;
}

export function scoreText(content: Extract<CanvasContent, { kind: 'score' }>): string {
  return content.homeScore !== null && content.awayScore !== null
    ? `${content.homeScore} – ${content.awayScore}`
    : '–';
}

/** The one line a folded card keeps: the score, or the first figure; null for the others. */
export function foldedSummary(content: CanvasContent): string | null {
  if (content.kind === 'score') {
    return `${content.home.name} ${scoreText(content)} ${content.away.name}`;
  }
  if (content.kind === 'stats' && content.items[0]) {
    return `${content.items[0].label} : ${content.items[0].value}`;
  }
  return null;
}

/**
 * The bot's page, in the strictest sandbox (JavaScript is also off in the WebView): no network,
 * nothing loaded from outside, no refresh that would show another page in its place.
 */
export function htmlCanvasPage(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`,
    '<style>:root{color-scheme:dark}html,body{margin:0;background:transparent;color:#e8e9ec;font:14px/1.5 -apple-system,system-ui,Roboto,sans-serif;-webkit-text-size-adjust:100%}</style>',
    '</head><body>',
    html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, ''),
    '</body></html>',
  ].join('');
}

/** The frame may only show the page it was given: links and redirects go nowhere. */
export function frameMayLoad(url: string): boolean {
  return url === 'about:blank' || url.startsWith('about:srcdoc') || url.startsWith('data:');
}

/** Raw bytes of a workspace file (images of canvases), loaded with the bearer header. */
export function workspaceFileUrl(base: string, workspaceId: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`;
}

// ---------------------------------------------------------------------------------------------
// Questions

/** A bot's open questions, oldest first (the order it asked them in). */
export function questionsOfBot(list: readonly Question[] | undefined, botId: string): Question[] {
  return (list ?? [])
    .filter((q) => q.botId === botId && q.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------------------------
// Notifications

export interface NotificationList {
  items: Notification[];
  unread: number;
}

/** Unread count as the hub gives it: digest-level notifications wait for the evening summary. */
export function unreadCount(items: readonly Notification[]): number {
  return items.filter((n) => !n.readAt && n.priority !== 'digest').length;
}

/** Marks some (or all) notifications read in the cache, before the hub confirms. */
export function markRead(
  list: NotificationList,
  ids: readonly string[] | undefined,
  now: Date = new Date(),
): NotificationList {
  const wanted = ids ? new Set(ids) : null;
  const items = list.items.map((n) =>
    !n.readAt && (!wanted || wanted.has(n.id)) ? { ...n, readAt: now.toISOString() } : n,
  );
  return { items, unread: unreadCount(items) };
}

export type DayGroup = 'today' | 'yesterday' | 'earlier';

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function dayGroup(iso: string, now: Date = new Date()): DayGroup {
  const day = startOfDay(new Date(iso));
  const today = startOfDay(now);
  if (day >= today) return 'today';
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return day >= yesterday ? 'yesterday' : 'earlier';
}

const DAY_GROUPS: readonly DayGroup[] = ['today', 'yesterday', 'earlier'];

/** Today, yesterday, earlier (empty groups left out); items keep their order within a group. */
export function groupByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now: Date = new Date(),
): { day: DayGroup; items: T[] }[] {
  return DAY_GROUPS.map((day) => ({
    day,
    items: items.filter((item) => dayGroup(item.createdAt, now) === day),
  })).filter((group) => group.items.length > 0);
}
