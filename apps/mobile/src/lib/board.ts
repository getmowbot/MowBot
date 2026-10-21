import type {
  Bot,
  Canvas,
  CanvasContent,
  CanvasSize,
  CardButton,
  Notification,
  Question,
} from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { normalizePath, previewKind } from './files';

/**
 * Pure logic of the canvases (on Home and inside conversations) and of the notifications (no
 * React, no native modules): greeting, canvases order and layout, card buttons and pictures,
 * file previews, checklist and notification cache changes, the sandboxed page of `html` canvases.
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

/**
 * The one line a folded card keeps: the score, the first figure, a card's title (and subtitle),
 * how many pictures a gallery has, a file's name; null for the others.
 */
export function foldedSummary(content: CanvasContent, t: TFunction): string | null {
  switch (content.kind) {
    case 'score':
      return `${content.home.name} ${scoreText(content)} ${content.away.name}`;
    case 'stats':
      return content.items[0] ? `${content.items[0].label} : ${content.items[0].value}` : null;
    case 'card':
      return content.subtitle ? `${content.title} · ${content.subtitle}` : content.title;
    case 'gallery':
      return t('board.canvas.images', { count: content.images.length });
    case 'file':
      return content.name;
    default:
      return null;
  }
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
// Cards and galleries

/** Width / height of a card's picture (cropped to fill). */
export const CARD_IMAGE_RATIO = 16 / 9;
/** Width / height of a gallery's only picture. */
export const SINGLE_IMAGE_RATIO = 4 / 3;
/** Between a gallery's thumbnails. */
export const GALLERY_GAP = 10;

/** A picture from the web (loaded as is) rather than a file of the bot's workspace. */
export function isWebImage(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

/** Only web pages open from a card: never a scheme that would start another app silently. */
export function isWebLink(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * What a card's button does: open its page on this device, answer the bot, or both. A button
 * without a page always answers (its label then is the answer).
 */
export function cardButtonAction(button: CardButton): { open: string | null; answer: boolean } {
  const open = button.url && isWebLink(button.url) ? button.url : null;
  return { open, answer: Boolean(button.reply) || !open };
}

export interface CardButtonState {
  /** Drawn as the key action: the first button, or the one chosen once the card is answered. */
  primary: boolean;
  /** The one the user pressed (a card in a message is answered once). */
  chosen: boolean;
  /** Would answer the bot again: off once the card is answered (link-only buttons still open). */
  locked: boolean;
}

/**
 * How a card's button shows. `pressed`: the label pressed in a message (null: not yet), or
 * undefined for a card on Home, which can be answered again and again.
 */
export function cardButtonState(
  button: CardButton,
  index: number,
  pressed: string | null | undefined,
): CardButtonState {
  const answered = typeof pressed === 'string';
  const chosen = answered && pressed === button.label;
  return {
    primary: answered ? chosen : index === 0,
    chosen,
    locked: answered && cardButtonAction(button).answer,
  };
}

/**
 * Side of a gallery's square thumbnails in a row `width` wide: two side by side, more with the
 * next one peeking out (the row scrolls). A single picture takes the whole width.
 */
export function galleryThumbSize(count: number, width: number): number {
  if (width <= 0) return 0;
  if (count <= 1) return width;
  if (count === 2) return Math.floor((width - GALLERY_GAP) / 2);
  return Math.floor(Math.min(160, Math.max(112, (width - GALLERY_GAP * 2) / 2.4)));
}

// ---------------------------------------------------------------------------------------------
// Files

type FileCanvas = Extract<CanvasContent, { kind: 'file' }>;

/** What a file card loads of a text for its preview: its beginning, in one Range request. */
export const FILE_HEAD_BYTES = 8 * 1024;
/** Lines of text a file card shows (Markdown gets a few more: blank lines separate blocks). */
export const FILE_TEXT_LINES = 12;
export const FILE_MARKDOWN_LINES = 16;
/** Height of a file card's preview: a picture is contained in it, text fades out past it. */
export const FILE_PREVIEW_HEIGHT = 260;
/** Pictures above this are not loaded in a card (the viewer still shows them). */
const FILE_IMAGE_BYTES = 10 * 1024 ** 2;

/** What a file card shows inline: a picture, the first lines of a text, or nothing. */
export type FilePreview = 'image' | 'markdown' | 'text' | null;

export function filePreview(content: FileCanvas): FilePreview {
  if (content.type === 'directory') return null;
  const kind = previewKind(content.name, content.size);
  if (kind === 'image') return content.size <= FILE_IMAGE_BYTES ? 'image' : null;
  // An empty text has nothing to show.
  if (kind === 'markdown' || kind === 'text') return content.size > 0 ? kind : null;
  return null;
}

/**
 * Height of a picture in a file card `width` wide: its own proportions (4:3 until it has
 * loaded), capped; a tall picture is contained in the frame.
 */
export function fileImageHeight(width: number, ratio: number | null): number {
  if (width <= 0) return 0;
  const proportion = ratio && ratio > 0 ? ratio : 4 / 3;
  return Math.round(Math.min(FILE_PREVIEW_HEIGHT, width / proportion));
}

/** `rapport.md` → `MD`; null without one (`Makefile`, `.env`). */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return ext.length <= 6 ? ext.toUpperCase() : null;
}

/** `bytes 0-8191/52310` → 52310 (null when the hub did not say). */
export function rangeTotal(header: string | null | undefined): number | null {
  const match = /\/(\d+)\s*$/.exec(header ?? '');
  return match ? Number(match[1]) : null;
}

const BYTE_ORDER_MARK = 0xfeff;
/** What a decoder puts in place of a character cut in half. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * The first lines of a text, for a card. `cut`: the text is only the file's beginning, so its
 * last line may stop mid-way (or mid-character) and is dropped. Blank lines at the end are
 * trimmed; `more` says something is left out. Markdown loses its front matter.
 */
export function textExcerpt(
  text: string,
  options: { lines: number; cut?: boolean; markdown?: boolean },
): { text: string; more: boolean } {
  const { lines: max, cut = false, markdown = false } = options;
  let body = text.replace(/\r\n?/g, '\n');
  if (body.charCodeAt(0) === BYTE_ORDER_MARK) body = body.slice(1);
  if (markdown) body = body.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
  let lines = body.split('\n');
  if (cut && lines.length > 1) lines = lines.slice(0, -1);
  const trimEnd = () => {
    while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  };
  trimEnd();
  let more = cut;
  if (lines.length > max) {
    lines = lines.slice(0, max);
    more = true;
    trimEnd();
  }
  let excerpt = lines.join('\n');
  // A single line cut mid-character ends in replacement characters.
  while (excerpt.endsWith(REPLACEMENT_CHARACTER)) excerpt = excerpt.slice(0, -1);
  return { text: excerpt, more };
}

/** Where a file card leads: the file's viewer, or the files browser at that folder. */
export function fileCanvasRoute(
  workspaceId: string,
  content: Pick<FileCanvas, 'path' | 'type'>,
): {
  pathname: '/files/[workspaceId]' | '/files/[workspaceId]/view';
  params: Record<string, string>;
} {
  const path = normalizePath(content.path);
  return {
    pathname: content.type === 'directory' ? '/files/[workspaceId]' : '/files/[workspaceId]/view',
    params: { workspaceId, path },
  };
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

/** A tab bar badge: nothing at zero, then the count, capped. */
export function badgeText(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 99 ? '99+' : String(count);
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
