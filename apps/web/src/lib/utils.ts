import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { i18n } from '../i18n';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Best-effort device label shown in the devices list, e.g. "Chrome · Windows". */
export function guessDeviceName(userAgent: string = navigator.userAgent): string {
  const browser =
    [
      ['Edg/', 'Edge'],
      ['Firefox/', 'Firefox'],
      ['Chrome/', 'Chrome'],
      ['Safari/', 'Safari'],
    ].find(([token]) => token && userAgent.includes(token))?.[1] ?? i18n.t('devices.browser');
  const os =
    [
      ['Windows', 'Windows'],
      ['Android', 'Android'],
      ['iPhone', 'iOS'],
      ['iPad', 'iPadOS'],
      ['Mac OS', 'macOS'],
      ['Linux', 'Linux'],
    ].find(([token]) => token && userAgent.includes(token))?.[1] ?? '';
  return os ? `${browser} · ${os}` : browser;
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** "il y a 5 minutes", "yesterday"… in the app's language. */
export function timeAgo(iso: string, now = Date.now()): string {
  const locale = i18n.language;
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormats.set(locale, format);
  }
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return i18n.t('time.justNow');
}

/** A date (and time) in the app's language. */
export function formatDate(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(i18n.language, options).format(new Date(iso));
}
