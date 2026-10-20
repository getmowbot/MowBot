import { type FileEntry, TRASH_FOLDER } from '@mowbot/contract';

/**
 * Pure helpers of the file browser: workspace paths (POSIX, `''` = the root), names shown to
 * the user, what a file can be previewed as, sizes. No React, no native modules: unit tested.
 */

export { TRASH_FOLDER };

/** `outputs` + `report.md` → `outputs/report.md`. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** `outputs/report.md` → `outputs`; a top-level entry → `''`. */
export function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** `outputs/report.md` → `report.md`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `a/b/c` → `['a', 'b', 'c']`; the root has none. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** A path from a link (`/outputs/`, undefined) in the hub's form (`outputs`, `''`). */
export function normalizePath(input: string | undefined): string {
  return pathSegments(input ?? '').join('/');
}

/** The trash folder or anything in it (deleting there is for good). */
export function isInTrash(path: string): boolean {
  return path === TRASH_FOLDER || path.startsWith(`${TRASH_FOLDER}/`);
}

// The hub prefixes trashed entries with the time they were deleted: `2026-10-20T08-15-02-123Z-`.
const TRASH_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)$/;

/** A trashed entry's name before it was deleted (other names are returned as is). */
export function originalName(name: string): string {
  return TRASH_STAMP.exec(name)?.[1] ?? name;
}

/** What the user reads for a path: the trash by its name, trashed entries without their stamp. */
export function displayName(path: string, trashLabel: string): string {
  if (path === TRASH_FOLDER) return trashLabel;
  const name = baseName(path);
  return parentOf(path) === TRASH_FOLDER ? originalName(name) : name;
}

/**
 * A name typed for a new folder or a rename: trimmed, one path segment. Null when it cannot be
 * one (empty, `.`/`..`, a slash, too long).
 */
export function validName(input: string): string | null {
  const name = input.trim();
  if (!name || name === '.' || name === '..' || name.length > 255) return null;
  if (/[/\\\0]/.test(name)) return null;
  return name;
}

/** Where an entry lands when moved into `dir`; leaving the trash restores its original name. */
export function moveTarget(from: string, dir: string): string {
  const name = baseName(from);
  return joinPath(dir, parentOf(from) === TRASH_FOLDER ? originalName(name) : name);
}

/** Whether `from` can move into `dir`: not where it already is, not a folder into itself. */
export function canMoveInto(from: string, dir: string): boolean {
  if (dir === parentOf(from)) return false;
  return dir !== from && !dir.startsWith(`${from}/`);
}

/** Folders first, files after, the trash last (the hub already sorts by name). */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  const rank = (entry: FileEntry) =>
    entry.path === TRASH_FOLDER ? 2 : entry.type === 'directory' ? 0 : 1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

const MARKDOWN = new Set(['md', 'markdown']);
const PLAIN = new Set(['txt', 'log', 'csv', 'tsv', 'env', 'ini', 'conf', 'toml', 'yml', 'yaml']);
const CODE = new Set([
  'json',
  'jsonl',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'sh',
  'bash',
  'sql',
]);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
const VIDEO = new Set(['mp4', 'webm', 'mov', 'mkv']);
const ARCHIVE = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);
const SHEET = new Set(['xlsx', 'xls', 'ods']);

/** Drives the icon of a row. */
export type FileKind =
  | 'markdown'
  | 'text'
  | 'code'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'archive'
  | 'sheet'
  | 'other';

export function fileKind(name: string): FileKind {
  const ext = extensionOf(name);
  if (MARKDOWN.has(ext)) return 'markdown';
  if (ext === 'csv' || ext === 'tsv' || SHEET.has(ext)) return 'sheet';
  if (PLAIN.has(ext)) return 'text';
  if (CODE.has(ext)) return 'code';
  if (IMAGE.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO.has(ext)) return 'audio';
  if (VIDEO.has(ext)) return 'video';
  if (ARCHIVE.has(ext)) return 'archive';
  return 'other';
}

/** Above this, a text preview only shows the beginning (a Range request). */
export const TEXT_PREVIEW_BYTES = 256 * 1024;
const IMAGE_PREVIEW_BYTES = 25 * 1024 ** 2;
const PDF_PREVIEW_BYTES = 50 * 1024 ** 2;

/** How the app can show a file; null: no preview, it can be shared to another app. */
export type PreviewKind = 'markdown' | 'text' | 'image' | 'pdf';

export function previewKind(name: string, size: number): PreviewKind | null {
  const kind = fileKind(name);
  if (kind === 'markdown') return 'markdown';
  if (kind === 'text' || kind === 'code' || (kind === 'sheet' && /\.(csv|tsv)$/i.test(name))) {
    return 'text';
  }
  if (kind === 'image' && size <= IMAGE_PREVIEW_BYTES) return 'image';
  if (kind === 'pdf' && size <= PDF_PREVIEW_BYTES) return 'pdf';
  return null;
}

const MIME: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** For the share sheet, so the receiving apps know what they get. */
export function mimeTypeFor(name: string): string {
  return MIME[extensionOf(name)] ?? 'application/octet-stream';
}

/** A name that is safe as a local file name (the share sheet shows it). */
export function localFileName(name: string, fallback = 'file'): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
  const cleaned = name.replace(/[/\\:\u0000-\u001f]/g, '_').trim();
  return (cleaned || fallback).slice(0, 200);
}

export type SizeUnit = 'b' | 'kb' | 'mb' | 'gb' | 'tb';
const UNITS = ['kb', 'mb', 'gb', 'tb'] as const;

/** `1,5 Mo` / `1.5 MB`: one decimal under 10, none above. */
export function formatSize(
  bytes: number,
  units: Readonly<Record<SizeUnit, string>>,
  language: string,
): string {
  if (bytes < 1024) return `${bytes} ${units.b}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  let number: string;
  try {
    number = new Intl.NumberFormat(language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    number = value.toFixed(digits);
  }
  return `${number} ${units[UNITS[unit] ?? 'tb']}`;
}

/** Long text cut into blocks of lines, so a list only lays out what is on screen. */
export function textChunks(text: string, linesPerChunk = 120): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += linesPerChunk) {
    chunks.push(lines.slice(start, start + linesPerChunk).join('\n'));
  }
  return chunks.length > 0 ? chunks : [''];
}

/** Raw bytes of a file, for previews loaded by URL (images). */
export function contentUrl(hub: string, workspaceId: string, path: string): string {
  return `${hub}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`;
}

/** One-time download link (a file, or a zip of a folder); needs no auth header. */
export function downloadUrl(hub: string, ticket: string): string {
  return `${hub}/api/v1/downloads/${encodeURIComponent(ticket)}`;
}
