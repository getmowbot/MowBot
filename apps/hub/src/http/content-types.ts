import path from 'node:path';

const TYPES: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

/** Types a browser could execute (HTML, scripts) are served as plain text, never rendered. */
const ACTIVE = new Set(['.html', '.htm', '.xhtml', '.js', '.mjs', '.css', '.xml']);

export function contentTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ACTIVE.has(ext)) return 'text/plain; charset=utf-8';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** RFC 6266 attachment header that survives non-ASCII names. */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Files written by bots are untrusted: never sniff, and sandbox anything a browser might
 * render so it cannot run with the app's origin.
 */
export const UNTRUSTED_FILE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  'cache-control': 'private, no-store',
} as const;

/** Parses a single `bytes=start-end` range. Returns null for absent/unsupported ranges. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}
