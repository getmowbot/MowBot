import type { RoutineTrigger } from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { type Checked, normalizeTime } from './proactivity-form';

export type TriggerType = RoutineTrigger['type'];
export const TRIGGER_TYPES: readonly TriggerType[] = ['cron', 'interval', 'once', 'webhook'];

const pad = (n: number) => String(n).padStart(2, '0');
const DAY_MS = 86_400_000;

/** The schema's bounds for intervals (minutes). */
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 60 * 24 * 31;

/* ------------------------------------------------------------------ dates */

/** A local calendar day as typed in the form ("2026-10-21"). */
export function dayText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "2026-10-21" or "21/10/2026" → that local day, or null (also for 31/02). */
export function parseDay(text: string): { year: number; month: number; day: number } | null {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const european = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(value);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : european
      ? [Number(european[3]), Number(european[2]), Number(european[1])]
      : [0, 0, 0];
  if (!year) return null;
  const date = new Date(year, month - 1, day);
  const real =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? { year, month, day } : null;
}

/** A local day and time of day → the moment, or null when either cannot be read. */
export function parseLocalDateTime(day: string, time: string): Date | null {
  const date = parseDay(day);
  const clock = normalizeTime(time);
  if (!date || !clock) return null;
  const [hours = 0, minutes = 0] = clock.split(':').map(Number);
  return new Date(date.year, date.month - 1, date.day, hours, minutes);
}

/** "08:00" in the phone's way of writing times (24 h in French, maybe 8:00 AM in English). */
export function clockText(date: Date, language: string): string {
  try {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

/** "21 Oct, 08:00" (with the year when it is not this one). */
export function dateTimeText(iso: string, language: string, now = new Date()): string {
  const date = new Date(iso);
  try {
    const day = date.toLocaleDateString(language, {
      day: 'numeric',
      month: 'short',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
    return `${day}, ${clockText(date, language)}`;
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** When a routine fires next: "today at 08:00", "tomorrow at…", "Friday at…", "21 Oct at…". */
export function nextRunText(iso: string, t: TFunction, language: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.getTime() <= now.getTime()) return t('appAdmin.routines.dueNow');
  const time = clockText(date, language);
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (days === 0) return t('appAdmin.routines.todayAt', { time });
  if (days === 1) return t('appAdmin.routines.tomorrowAt', { time });
  let day: string;
  try {
    day =
      days < 7
        ? date.toLocaleDateString(language, { weekday: 'long' })
        : date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
  } catch {
    day = dayText(date);
  }
  return t('appAdmin.routines.dayAt', { day, time });
}

/* ------------------------------------------------------------------ cron */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const numberIn = (text: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
};

const weekdayOf = (text: string): number | null => {
  const named = WEEKDAYS.indexOf(text.toLowerCase() as (typeof WEEKDAYS)[number]);
  if (named >= 0) return named;
  const value = numberIn(text, 0, 7);
  return value === null ? null : value % 7;
};

/** "1-5", "MON,WED,FRI", "0,6" → the days of the week (0 = Sunday), or null. */
export function cronWeekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const [from, to, ...rest] = part.split('-');
    if (rest.length > 0 || from === undefined) return null;
    const start = weekdayOf(from);
    const end = to === undefined ? start : weekdayOf(to);
    if (start === null || end === null || (to !== undefined && end < start && end !== 0)) {
      return null;
    }
    // "5-7": Friday to Sunday (7 is Sunday again).
    const last = to !== undefined && end === 0 ? 7 : end;
    for (let day = start; day <= last; day++) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** Common cron expressions in words ("every day at 08:00"); null for the others. */
export function describeCron(expr: string, t: TFunction): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = fields;
  const everyDay = dom === '*' && month === '*' && dow === '*';
  const step = (field: string) => /^\*\/(\d{1,4})$/.exec(field)?.[1];

  const minuteStep = step(minute);
  if (minuteStep && hour === '*' && everyDay) {
    return t('appAdmin.routines.cron.everyMinutes', { count: Number(minuteStep) });
  }
  const m = numberIn(minute, 0, 59);
  if (m === null) return null;
  if (hour === '*' && everyDay) return t('appAdmin.routines.cron.hourly', { minute: pad(m) });
  const hourStep = step(hour);
  if (hourStep && everyDay) {
    return t('appAdmin.routines.cron.everyHours', { count: Number(hourStep), minute: pad(m) });
  }
  const h = numberIn(hour, 0, 23);
  if (h === null || month !== '*') return null;
  const time = `${pad(h)}:${pad(m)}`;
  if (dom === '*') {
    if (dow === '*') return t('appAdmin.routines.cron.daily', { time });
    const days = cronWeekdays(dow);
    if (!days || days.length === 0) return null;
    const key = days.join(',');
    if (key === '1,2,3,4,5') return t('appAdmin.routines.cron.weekdays', { time });
    if (key === '0,6') return t('appAdmin.routines.cron.weekends', { time });
    if (days.length === 7) return t('appAdmin.routines.cron.daily', { time });
    // Monday first, as calendars in French and most of Europe.
    const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
    const names = ordered.map((d) => t(`appAdmin.routines.days.${WEEKDAYS[d] ?? 'sun'}`));
    return t('appAdmin.routines.cron.weekly', { days: names.join(', '), time });
  }
  const day = numberIn(dom, 1, 31);
  if (day === null || dow !== '*') return null;
  return t('appAdmin.routines.cron.monthly', { day, time });
}

/* ------------------------------------------------------------------ triggers */

/** When a routine fires, in words. */
export function describeTrigger(trigger: RoutineTrigger, t: TFunction, language: string): string {
  switch (trigger.type) {
    case 'cron':
      return (
        describeCron(trigger.expr, t) ?? t('appAdmin.routines.trigger.cron', { expr: trigger.expr })
      );
    case 'interval': {
      const { minutes } = trigger;
      if (minutes % 1440 === 0) {
        return t('appAdmin.routines.trigger.days', { count: minutes / 1440 });
      }
      if (minutes % 60 === 0) {
        return t('appAdmin.routines.trigger.hours', { count: minutes / 60 });
      }
      return t('appAdmin.routines.trigger.minutes', { count: minutes });
    }
    case 'once':
      return t('appAdmin.routines.trigger.once', { date: dateTimeText(trigger.at, language) });
    case 'webhook':
      return t('appAdmin.routines.trigger.webhook');
  }
}

/** The trigger fields of the form, as typed (every type keeps its own value). */
export interface TriggerDraft {
  type: TriggerType;
  cron: string;
  minutes: string;
  day: string;
  time: string;
}

/** The form for a trigger (or the defaults: every day at 08:00, tomorrow 08:00…). */
export function triggerDraft(trigger?: RoutineTrigger, now = new Date()): TriggerDraft {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0);
  const draft: TriggerDraft = {
    type: 'cron',
    cron: '0 8 * * *',
    minutes: '60',
    day: dayText(tomorrow),
    time: '08:00',
  };
  switch (trigger?.type) {
    case undefined:
      return draft;
    case 'cron':
      return { ...draft, cron: trigger.expr };
    case 'interval':
      return { ...draft, type: 'interval', minutes: String(trigger.minutes) };
    case 'once': {
      const at = new Date(trigger.at);
      return {
        ...draft,
        type: 'once',
        day: dayText(at),
        time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
      };
    }
    case 'webhook':
      return { ...draft, type: 'webhook' };
  }
}

export type TriggerProblem = 'cron' | 'minutes' | 'day' | 'time' | 'past';

/** The trigger to send, checked like the hub does where it can be done here. */
export function checkTrigger(
  draft: TriggerDraft,
  now = new Date(),
): Checked<RoutineTrigger, TriggerProblem> {
  switch (draft.type) {
    case 'cron': {
      const expr = draft.cron.trim().replace(/\s+/g, ' ');
      const fields = expr.split(' ').length;
      if ((fields !== 5 && fields !== 6) || expr.length < 9 || expr.length > 100) {
        return { ok: false, problem: 'cron' };
      }
      return { ok: true, value: { type: 'cron', expr } };
    }
    case 'interval': {
      const text = draft.minutes.trim();
      const minutes = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (!(minutes >= MIN_INTERVAL && minutes <= MAX_INTERVAL)) {
        return { ok: false, problem: 'minutes' };
      }
      return { ok: true, value: { type: 'interval', minutes } };
    }
    case 'once': {
      if (!parseDay(draft.day)) return { ok: false, problem: 'day' };
      const at = parseLocalDateTime(draft.day, draft.time);
      if (!at) return { ok: false, problem: 'time' };
      if (at.getTime() <= now.getTime()) return { ok: false, problem: 'past' };
      return { ok: true, value: { type: 'once', at: at.toISOString() } };
    }
    case 'webhook':
      return { ok: true, value: { type: 'webhook' } };
  }
}

export type RoutineProblem = 'bot' | 'name' | 'prompt' | TriggerProblem;

/** The first thing missing or wrong in the routine form, in the order of the fields. */
export function routineProblem(input: {
  botId: string | null;
  name: string;
  prompt: string;
  trigger: Checked<RoutineTrigger, TriggerProblem>;
}): RoutineProblem | null {
  if (!input.botId) return 'bot';
  if (!input.name.trim()) return 'name';
  if (!input.prompt.trim()) return 'prompt';
  return input.trigger.ok ? null : input.trigger.problem;
}

export function sameTrigger(a: RoutineTrigger, b: RoutineTrigger): boolean {
  switch (a.type) {
    case 'cron':
      return b.type === 'cron' && a.expr === b.expr;
    case 'interval':
      return b.type === 'interval' && a.minutes === b.minutes;
    case 'once':
      return b.type === 'once' && new Date(a.at).getTime() === new Date(b.at).getTime();
    case 'webhook':
      return b.type === 'webhook';
  }
}
