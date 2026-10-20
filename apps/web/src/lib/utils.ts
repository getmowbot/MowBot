import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
    ].find(([token]) => token && userAgent.includes(token))?.[1] ?? 'Navigateur';
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

const RELATIVE = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

/** "il y a 5 minutes", "hier"… */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return 'à l’instant';
}
