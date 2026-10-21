import type { Automation, AutomationStatus } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { clockText, dateTimeText } from './routine-form';
import { timeAgo } from './time';

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/** How often it runs: "toutes les 30 s", "toutes les 5 min", "toutes les heures"… */
export function rhythmText(seconds: number, t: TFunction): string {
  if (seconds >= DAY && seconds % DAY === 0) {
    return t('appAdmin.automations.every.days', { count: seconds / DAY });
  }
  if (seconds >= HOUR && seconds % HOUR === 0) {
    return t('appAdmin.automations.every.hours', { count: seconds / HOUR });
  }
  if (seconds >= MINUTE && seconds % MINUTE === 0) {
    return t('appAdmin.automations.every.minutes', { count: seconds / MINUTE });
  }
  if (seconds < 2 * MINUTE) return t('appAdmin.automations.every.seconds', { count: seconds });
  return t('appAdmin.automations.every.minutesSeconds', {
    minutes: Math.floor(seconds / MINUTE),
    seconds: seconds % MINUTE,
  });
}

/** When it stops by itself: "jusqu’à 22:00" today, "jusqu’au 21 oct., 22:00" another day. */
export function untilText(iso: string, t: TFunction, language: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toDateString() === now.toDateString()
    ? t('appAdmin.automations.untilTime', { time: clockText(date, language) })
    : t('appAdmin.automations.untilDate', { date: dateTimeText(iso, language, now) });
}

export function automationStatusLabel(automation: Pick<Automation, 'status'>, t: TFunction) {
  return t(`appAdmin.automations.status.${automation.status}`);
}

/** `live`: running; `warning`: its last runs failed; `off`: paused or over. */
export type AutomationTone = 'live' | 'warning' | 'off';

export function automationTone(
  automation: Pick<Automation, 'status' | 'failures'>,
): AutomationTone {
  if (automation.failures > 0 && automation.status !== 'stopped') return 'warning';
  return automation.status === 'active' ? 'live' : 'off';
}

/**
 * What it did last: why it paused or ended (when it did), when it last ran and what that run
 * gave ("Match terminé · il y a 3 min · 2-1").
 */
export function automationDetail(
  automation: Pick<Automation, 'status' | 'stoppedReason' | 'lastRunAt' | 'lastResult'>,
  t: TFunction,
  language: string,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (automation.status !== 'active' && automation.stoppedReason) {
    parts.push(automation.stoppedReason);
  }
  parts.push(
    automation.lastRunAt
      ? timeAgo(automation.lastRunAt, t, language, now)
      : t('appAdmin.automations.neverRun'),
  );
  if (automation.lastResult) parts.push(automation.lastResult);
  return parts.join(' · ');
}

/** Whether an active automation keeps this home card up to date (it shows a "Live" badge). */
export function isCanvasLive(
  automations: readonly Pick<Automation, 'status' | 'canvasId'>[],
  canvasId: string,
): boolean {
  return automations.some((a) => a.status === 'active' && a.canvasId === canvasId);
}

const ORDER: Record<AutomationStatus, number> = { active: 0, paused: 1, stopped: 2 };

/** Running ones first, then paused, then the finished ones; newest first in each. */
export function sortAutomations<T extends Pick<Automation, 'status' | 'createdAt'>>(
  automations: readonly T[],
): T[] {
  return [...automations].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
}
