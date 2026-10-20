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
