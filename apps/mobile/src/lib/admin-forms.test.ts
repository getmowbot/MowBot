import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { translator } from '../test/fixtures';
import { checkBudget, checkQuietHours, normalizeTime } from './proactivity-form';
import {
  hasZdr,
  headerRow,
  headerRows,
  headersProblem,
  headersRecord,
  isHttpUrl,
  providerFormProblem,
  sameHeaders,
  toggleZdr,
  urlLabel,
  ZDR_HEADER,
} from './provider-form';
import {
  checkTrigger,
  cronWeekdays,
  describeCron,
  describeTrigger,
  nextRunText,
  parseDay,
  parseLocalDateTime,
  routineProblem,
  sameTrigger,
  triggerDraft,
} from './routine-form';

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

describe('provider headers', () => {
  it('round-trips a record through editable rows', () => {
    const headers = { 'x-cmd-zdr': '1', 'X-Title': 'MowBot' };
    const rows = headerRows(headers);
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ['x-cmd-zdr', '1'],
      ['X-Title', 'MowBot'],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(headersRecord(rows)).toEqual(headers);
  });

  it('trims and leaves blank lines out', () => {
    const rows = [headerRow(' X-A ', ' 1 '), headerRow('', ''), headerRow('X-B', '')];
    expect(headersRecord(rows)).toEqual({ 'X-A': '1', 'X-B': '' });
  });

  it('refuses what the hub would refuse', () => {
    expect(headersProblem([headerRow('X-Ok', 'v')])).toBeNull();
    expect(headersProblem([headerRow('', '')])).toBeNull();
    expect(headersProblem([headerRow('bad name', 'v')])).toBe('headerName');
    expect(headersProblem([headerRow('', 'orphan value')])).toBe('headerName');
    expect(headersProblem([headerRow('X-A', 'two\nlines')])).toBe('headerValue');
    expect(headersProblem([headerRow('X-A', '1'), headerRow('x-a', '2')])).toBe('headerDuplicate');
    const many = Array.from({ length: 21 }, (_, i) => headerRow(`X-${i}`, '1'));
    expect(headersProblem(many)).toBe('headerTooMany');
  });

  it('checks the provider form', () => {
    const base = { kind: 'openai' as const, name: 'OpenAI', baseUrl: '', rows: [] };
    expect(providerFormProblem({ ...base, editing: false })).toBeNull();
    expect(providerFormProblem({ ...base, name: ' ', editing: false })).toBe('name');
    expect(providerFormProblem({ ...base, kind: 'openai-compatible', editing: false })).toBe(
      'urlRequired',
    );
    expect(providerFormProblem({ ...base, baseUrl: 'localhost:11434', editing: false })).toBe(
      'url',
    );
    expect(providerFormProblem({ ...base, editing: true })).toBe('url');
    expect(providerFormProblem({ ...base, rows: [headerRow('a b', '1')], editing: false })).toBe(
      'headerName',
    );
  });

  it('compares header sets regardless of order', () => {
    expect(sameHeaders({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameHeaders({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameHeaders({ a: '1' }, {})).toBe(false);
  });

  it('switches Zero Data Retention on and off', () => {
    const on = toggleZdr([headerRow('X-A', '1')]);
    expect(hasZdr(on)).toBe(true);
    expect(headersRecord(on)).toEqual({ 'X-A': '1', [ZDR_HEADER]: '1' });
    const off = toggleZdr(on);
    expect(hasZdr(off)).toBe(false);
    expect(headersRecord(off)).toEqual({ 'X-A': '1' });
    expect(hasZdr([headerRow('X-CMD-ZDR', '1')])).toBe(true);
  });

  it('reads URLs', () => {
    expect(urlLabel('https://api.openai.com/v1/')).toBe('api.openai.com/v1');
    expect(isHttpUrl('http://192.168.1.20:11434/v1')).toBe(true);
    expect(isHttpUrl('api.openai.com')).toBe(false);
    expect(isHttpUrl('https://')).toBe(false);
  });
});

describe('quiet hours and budgets', () => {
  it('reads times the way people type them', () => {
    expect(normalizeTime('7')).toBe('07:00');
    expect(normalizeTime('7:30')).toBe('07:30');
    expect(normalizeTime('7h30')).toBe('07:30');
    expect(normalizeTime('22h')).toBe('22:00');
    expect(normalizeTime('0730')).toBe('07:30');
    expect(normalizeTime(' 23:59 ')).toBe('23:59');
    expect(normalizeTime('24:00')).toBeNull();
    expect(normalizeTime('12:60')).toBeNull();
    expect(normalizeTime('noon')).toBeNull();
    expect(normalizeTime('')).toBeNull();
  });

  it('checks the quiet window', () => {
    expect(checkQuietHours({ enabled: false, start: 'x', end: 'y' })).toEqual({
      ok: true,
      value: null,
    });
    expect(checkQuietHours({ enabled: true, start: '22h', end: '7' })).toEqual({
      ok: true,
      value: { start: '22:00', end: '07:00' },
    });
    expect(checkQuietHours({ enabled: true, start: '25:00', end: '07:00' })).toEqual({
      ok: false,
      problem: 'start',
    });
    expect(checkQuietHours({ enabled: true, start: '22:00', end: '' })).toEqual({
      ok: false,
      problem: 'end',
    });
    expect(checkQuietHours({ enabled: true, start: '8', end: '08:00' })).toEqual({
      ok: false,
      problem: 'same',
    });
  });

  it('reads token budgets', () => {
    expect(checkBudget('')).toEqual({ ok: true, value: null });
    expect(checkBudget('50 000')).toEqual({ ok: true, value: 50000 });
    expect(checkBudget('50,000')).toEqual({ ok: true, value: 50000 });
    expect(checkBudget('50 000')).toEqual({ ok: true, value: 50000 });
    expect(checkBudget('999')).toEqual({ ok: false, problem: 'budget' });
    expect(checkBudget('-5000')).toEqual({ ok: false, problem: 'budget' });
    expect(checkBudget('lots')).toEqual({ ok: false, problem: 'budget' });
  });
});

describe('routine triggers', () => {
  it('reads days of the week in cron', () => {
    expect(cronWeekdays('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(cronWeekdays('MON,wed,FRI')).toEqual([1, 3, 5]);
    expect(cronWeekdays('5-7')).toEqual([0, 5, 6]);
    expect(cronWeekdays('7')).toEqual([0]);
    expect(cronWeekdays('8')).toBeNull();
    expect(cronWeekdays('1-2-3')).toBeNull();
  });

  it('describes common cron expressions', () => {
    expect(describeCron('0 8 * * *', en)).toBe('every day at 08:00');
    expect(describeCron('0 8 * * *', fr)).toBe('tous les jours à 08:00');
    expect(describeCron('30 7 * * 1-5', en)).toBe('weekdays at 07:30');
    expect(describeCron('0 10 * * 0,6', fr)).toBe('le week-end à 10:00');
    expect(describeCron('0 9 * * 1,3,5', en)).toBe('Mon, Wed, Fri at 09:00');
    expect(describeCron('0 9 * * 0,1', fr)).toBe('lun., dim. à 09:00');
    expect(describeCron('0 6 1 * *', en)).toBe('on day 1 of each month at 06:00');
    expect(describeCron('*/15 * * * *', en)).toBe('every 15 minutes');
    expect(describeCron('5 * * * *', en)).toBe('every hour at :05');
    expect(describeCron('0 */2 * * *', fr)).toBe('toutes les 2 heures, à :00');
    // Anything fancier keeps its cron form.
    expect(describeCron('0 8 1 1 *', en)).toBeNull();
    expect(describeCron('0 8 * * MON#1', en)).toBeNull();
    expect(describeCron('0 0 8 * * *', en)).toBeNull();
  });

  it('describes every kind of trigger', () => {
    expect(describeTrigger({ type: 'cron', expr: '0 8 * * *' }, en, 'en')).toBe(
      'every day at 08:00',
    );
    expect(describeTrigger({ type: 'cron', expr: '0 8 1 1 *' }, en, 'en')).toBe('cron 0 8 1 1 *');
    expect(describeTrigger({ type: 'interval', minutes: 45 }, en, 'en')).toBe('every 45 minutes');
    expect(describeTrigger({ type: 'interval', minutes: 60 }, fr, 'fr')).toBe('toutes les heures');
    expect(describeTrigger({ type: 'interval', minutes: 180 }, en, 'en')).toBe('every 3 hours');
    expect(describeTrigger({ type: 'interval', minutes: 2880 }, fr, 'fr')).toBe('tous les 2 jours');
    expect(describeTrigger({ type: 'webhook' }, en, 'en')).toBe('when its URL is called');
    expect(describeTrigger({ type: 'once', at: '2026-12-24T18:00:00.000Z' }, en, 'en')).toMatch(
      /^once, on /,
    );
  });

  it('says when a routine fires next', () => {
    const now = new Date(2026, 9, 20, 12, 0);
    expect(nextRunText(new Date(2026, 9, 20, 11, 0).toISOString(), en, 'en', now)).toBe('due now');
    expect(nextRunText(new Date(2026, 9, 20, 18, 0).toISOString(), en, 'en', now)).toMatch(
      /^today at /,
    );
    expect(nextRunText(new Date(2026, 9, 21, 8, 0).toISOString(), fr, 'fr', now)).toMatch(
      /^demain à /,
    );
    expect(nextRunText(new Date(2026, 9, 23, 8, 0).toISOString(), en, 'en', now)).toMatch(
      /^Friday at /,
    );
  });

  it('reads the days and times typed for a one-off run', () => {
    expect(parseDay('2026-10-21')).toEqual({ year: 2026, month: 10, day: 21 });
    expect(parseDay('21/10/2026')).toEqual({ year: 2026, month: 10, day: 21 });
    expect(parseDay('2026-02-30')).toBeNull();
    expect(parseDay('tomorrow')).toBeNull();
    expect(parseLocalDateTime('2026-10-21', '8h15')?.getTime()).toBe(
      new Date(2026, 9, 21, 8, 15).getTime(),
    );
    expect(parseLocalDateTime('2026-10-21', '99:00')).toBeNull();
  });

  it('turns the form into a trigger', () => {
    const now = new Date(2026, 9, 20, 12, 0);
    const draft = triggerDraft(undefined, now);
    expect(draft).toMatchObject({ type: 'cron', cron: '0 8 * * *', day: '2026-10-21' });
    expect(checkTrigger({ ...draft, cron: ' 0  8 * * * ' }, now)).toEqual({
      ok: true,
      value: { type: 'cron', expr: '0 8 * * *' },
    });
    expect(checkTrigger({ ...draft, cron: '0 8 *' }, now)).toEqual({ ok: false, problem: 'cron' });
    expect(checkTrigger({ ...draft, type: 'interval', minutes: '90' }, now)).toEqual({
      ok: true,
      value: { type: 'interval', minutes: 90 },
    });
    expect(checkTrigger({ ...draft, type: 'interval', minutes: '4' }, now)).toEqual({
      ok: false,
      problem: 'minutes',
    });
    expect(checkTrigger({ ...draft, type: 'interval', minutes: '1.5' }, now)).toEqual({
      ok: false,
      problem: 'minutes',
    });
    const once = checkTrigger({ ...draft, type: 'once', day: '2026-10-21', time: '09:30' }, now);
    expect(once).toEqual({
      ok: true,
      value: { type: 'once', at: new Date(2026, 9, 21, 9, 30).toISOString() },
    });
    expect(checkTrigger({ ...draft, type: 'once', day: '2026-10-19' }, now)).toEqual({
      ok: false,
      problem: 'past',
    });
    expect(checkTrigger({ ...draft, type: 'once', day: 'soon' }, now)).toEqual({
      ok: false,
      problem: 'day',
    });
    expect(checkTrigger({ ...draft, type: 'once', time: '7pm' }, now)).toEqual({
      ok: false,
      problem: 'time',
    });
    expect(checkTrigger({ ...draft, type: 'webhook' }, now)).toEqual({
      ok: true,
      value: { type: 'webhook' },
    });
  });

  it('says what is missing in the routine form, field by field', () => {
    const trigger = { ok: true, value: { type: 'webhook' } } as const;
    const form = { botId: 'b1', name: 'Watch', prompt: 'Do it', trigger };
    expect(routineProblem(form)).toBeNull();
    expect(routineProblem({ ...form, botId: null })).toBe('bot');
    expect(routineProblem({ ...form, name: ' ' })).toBe('name');
    expect(routineProblem({ ...form, prompt: '' })).toBe('prompt');
    expect(routineProblem({ ...form, trigger: { ok: false, problem: 'past' } })).toBe('past');
  });

  it('fills the form from an existing trigger, and compares triggers', () => {
    const at = new Date(2026, 11, 24, 18, 5).toISOString();
    expect(triggerDraft({ type: 'once', at })).toMatchObject({
      type: 'once',
      day: '2026-12-24',
      time: '18:05',
    });
    expect(triggerDraft({ type: 'interval', minutes: 30 })).toMatchObject({
      type: 'interval',
      minutes: '30',
    });
    expect(sameTrigger({ type: 'webhook' }, { type: 'webhook' })).toBe(true);
    expect(sameTrigger({ type: 'cron', expr: '0 8 * * *' }, { type: 'interval', minutes: 5 })).toBe(
      false,
    );
    expect(
      sameTrigger(
        { type: 'once', at: '2026-12-24T17:05:00.000Z' },
        { type: 'once', at: '2026-12-24T18:05:00+01:00' },
      ),
    ).toBe(true);
  });
});
