import type { TFunction } from 'i18next';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** "il y a 5 min", "hier", then a date. Built from the catalog: no Intl.RelativeTimeFormat. */
export function timeAgo(iso: string, t: TFunction, language: string, now = Date.now()): string {
  const date = new Date(iso);
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < MINUTE) return t('time.justNow');
  if (seconds < HOUR) return t('time.minutes', { count: Math.floor(seconds / MINUTE) });
  if (seconds < DAY) return t('time.hours', { count: Math.floor(seconds / HOUR) });
  if (seconds < 7 * DAY) return t('time.days', { count: Math.floor(seconds / DAY) });
  try {
    return date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
