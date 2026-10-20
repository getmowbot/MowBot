import type { RoutineTrigger } from '@mowbot/contract';
import { Cron } from 'croner';

/** Two runs of a routine are at least this far apart (cron and interval). */
export const MIN_GAP_MS = 5 * 60_000;

/** When a routine fires next after `from`; null when it never will (past `once`, webhook). */
export function nextRun(trigger: RoutineTrigger, from: Date, timeZone: string): Date | null {
  switch (trigger.type) {
    case 'cron':
      return new Cron(trigger.expr, { timezone: timeZone }).nextRun(from);
    case 'interval':
      return new Date(from.getTime() + trigger.minutes * 60_000);
    case 'once': {
      const at = new Date(trigger.at);
      return at > from ? at : null;
    }
    case 'webhook':
      return null;
  }
}

/** Refuses triggers that are invalid or would fire too often; returns a reason in French. */
export function triggerProblem(
  trigger: RoutineTrigger,
  now: Date,
  timeZone: string,
): string | null {
  if (trigger.type === 'cron') {
    let cron: Cron;
    try {
      cron = new Cron(trigger.expr, { timezone: timeZone });
    } catch {
      return `Expression cron invalide : « ${trigger.expr} » (format : minute heure jour mois jour-de-semaine).`;
    }
    const [first, second] = cron.nextRuns(2, now);
    if (!first) return 'Cette expression cron ne se déclenche jamais.';
    if (second && second.getTime() - first.getTime() < MIN_GAP_MS) {
      return 'Une routine ne peut pas tourner plus d’une fois toutes les 5 minutes.';
    }
  }
  if (trigger.type === 'once' && new Date(trigger.at) <= now) {
    return 'La date doit être dans le futur.';
  }
  return null;
}

/** "HH:MM" → minutes since midnight. */
const minutesOf = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Whether `at` falls in the quiet window (which may cross midnight), in the given zone. */
export function inQuietHours(
  quiet: { start: string; end: string } | null,
  at: Date,
  timeZone: string,
): boolean {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const now = value('hour') * 60 + value('minute');
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** Midnight today in the given zone, as a Date (for "tokens spent today"). */
export function startOfDay(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsedMs =
    ((value('hour') * 60 + value('minute')) * 60 + value('second')) * 1000 + at.getMilliseconds();
  return new Date(at.getTime() - elapsedMs);
}
