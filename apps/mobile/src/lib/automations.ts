import type {
  Automation,
  AutomationOutcome,
  AutomationStatus,
  AutomationStop,
} from '@mowbot/contract';
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
 * What a run did ("Carte mise à jour · Bot réveillé", "Rien de neuf"), or why it failed
 * ("Le script a échoué (code 1)").
 */
export function outcomeText(outcome: AutomationOutcome, t: TFunction): string {
  const { error } = outcome;
  if (error) {
    if (error.kind === 'exit' && error.code !== null) {
      return t('appAdmin.automations.error.exitCode', { code: error.code });
    }
    // A timeout's detail is the limit it ran over ("60 s").
    if (error.kind === 'timeout') {
      return t('appAdmin.automations.error.timeout', { limit: error.detail || '60 s' });
    }
    return t(`appAdmin.automations.error.${error.kind}`);
  }
  if (!outcome.ok) return t('appAdmin.automations.error.other');
  return outcome.actions.length > 0
    ? outcome.actions.map((action) => t(`appAdmin.automations.did.${action}`)).join(' · ')
    : t('appAdmin.automations.did.nothing');
}

/** Errors whose detail is worth reading: the script's own output, or what is wrong with it. */
const READABLE_ERRORS: ReadonlySet<NonNullable<AutomationOutcome['error']>['kind']> = new Set([
  'exit',
  'output',
  'other',
]);

/** The last run's error as the script or the hub gave it (shown on demand), or null. */
export function errorDetail(outcome: Automation['lastOutcome']): string | null {
  const error = outcome?.error;
  return error && READABLE_ERRORS.has(error.kind) && error.detail.trim() ? error.detail : null;
}

/**
 * Why it ended or paused on its own: "Terminée : Match fini" (the script's words),
 * "Échéance atteinte", "En pause après 3 échecs".
 */
export function stopText(stop: AutomationStop, t: TFunction): string {
  switch (stop.reason) {
    case 'done':
      return stop.detail
        ? t('appAdmin.automations.stop.doneWith', { detail: stop.detail })
        : t('appAdmin.automations.stop.done');
    case 'deadline':
      return t('appAdmin.automations.stop.deadline');
    case 'failures': {
      const count = Number.parseInt(stop.detail ?? '', 10);
      return Number.isNaN(count)
        ? t('appAdmin.automations.status.paused')
        : t('appAdmin.automations.stop.failures', { count });
    }
  }
}

/**
 * What it did last: why it paused or ended (when it did), when it last ran and what that run
 * gave ("Terminée : Match fini · il y a 3 min · Carte mise à jour").
 */
export function automationDetail(
  automation: Pick<Automation, 'status' | 'stop' | 'lastRunAt' | 'lastOutcome'>,
  t: TFunction,
  language: string,
  now = Date.now(),
): string {
  const parts: string[] = [];
  if (automation.status !== 'active' && automation.stop) {
    parts.push(stopText(automation.stop, t));
  }
  parts.push(
    automation.lastRunAt
      ? timeAgo(automation.lastRunAt, t, language, now)
      : t('appAdmin.automations.neverRun'),
  );
  if (automation.lastOutcome) parts.push(outcomeText(automation.lastOutcome, t));
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
