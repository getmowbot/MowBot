import type { Automation, AutomationOutcome } from '@mowbot/contract';
import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { automation, translator } from '../test/fixtures';
import {
  automationDetail,
  automationStatusLabel,
  automationTone,
  errorDetail,
  isCanvasLive,
  outcomeText,
  rhythmText,
  sortAutomations,
  stopText,
  untilText,
} from './automations';
import { applyServerEvent } from './event-cache';
import { keys } from './query-keys';

type ErrorKind = NonNullable<AutomationOutcome['error']>['kind'];

const success = (...actions: AutomationOutcome['actions']): AutomationOutcome => ({
  ok: true,
  actions,
  error: null,
});

const failure = (kind: ErrorKind, code: number | null = null, detail = ''): AutomationOutcome => ({
  ok: false,
  actions: [],
  error: { kind, code, detail },
});

let fr: TFunction;
let en: TFunction;

beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

describe('automation rhythm', () => {
  it('says how often it runs in the largest round unit', () => {
    expect(rhythmText(30, fr)).toBe('toutes les 30 s');
    expect(rhythmText(15, en)).toBe('every 15 s');
    expect(rhythmText(90, fr)).toBe('toutes les 90 s');
    expect(rhythmText(60, fr)).toBe('toutes les minutes');
    expect(rhythmText(300, en)).toBe('every 5 min');
    expect(rhythmText(150, fr)).toBe('toutes les 2 min 30 s');
    expect(rhythmText(5400, en)).toBe('every 90 min');
    expect(rhythmText(3600, fr)).toBe('toutes les heures');
    expect(rhythmText(7200, en)).toBe('every 2 h');
    expect(rhythmText(86_400, fr)).toBe('tous les jours');
    expect(rhythmText(172_800, en)).toBe('every 2 days');
  });
});

describe('automation end', () => {
  it('gives the time alone when it ends today, the day otherwise', () => {
    const now = new Date(2026, 9, 21, 15, 0);
    expect(untilText(new Date(2026, 9, 21, 22, 0).toISOString(), fr, 'fr', now)).toMatch(
      /^jusqu’à 22:00$/,
    );
    expect(untilText(new Date(2026, 9, 23, 8, 0).toISOString(), en, 'en', now)).toMatch(
      /^until (Oct 23|23 Oct).*08:00/,
    );
  });
});

describe('automation status', () => {
  it('words the status', () => {
    expect(automationStatusLabel({ status: 'active' }, fr)).toBe('Active');
    expect(automationStatusLabel({ status: 'paused' }, fr)).toBe('En pause');
    expect(automationStatusLabel({ status: 'stopped' }, fr)).toBe('Terminée');
    expect(automationStatusLabel({ status: 'stopped' }, en)).toBe('Finished');
  });

  it('warns while its runs fail, until it is over', () => {
    expect(automationTone({ status: 'active', failures: 0 })).toBe('live');
    expect(automationTone({ status: 'active', failures: 1 })).toBe('warning');
    expect(automationTone({ status: 'paused', failures: 3 })).toBe('warning');
    expect(automationTone({ status: 'paused', failures: 0 })).toBe('off');
    expect(automationTone({ status: 'stopped', failures: 2 })).toBe('off');
  });

  it('tells what it last did, and why it paused or ended', () => {
    const now = Date.UTC(2026, 9, 21, 12, 0);
    const twoMinutesAgo = new Date(now - 120_000).toISOString();
    expect(automationDetail(automation(), fr, 'fr', now)).toBe('Pas encore lancée');
    expect(
      automationDetail(
        automation({ lastRunAt: twoMinutesAgo, lastOutcome: success('canvas') }),
        fr,
        'fr',
        now,
      ),
    ).toBe('il y a 2 min · Carte mise à jour');
    expect(
      automationDetail(
        automation({
          status: 'stopped',
          stop: { reason: 'done', detail: 'Match terminé' },
          lastRunAt: twoMinutesAgo,
          lastOutcome: success('canvas', 'notify'),
        }),
        en,
        'en',
        now,
      ),
    ).toBe('Finished: Match terminé · 2 min ago · Card updated · Notification sent');
    expect(
      automationDetail(
        automation({
          status: 'paused',
          failures: 3,
          stop: { reason: 'failures', detail: '3' },
          lastRunAt: twoMinutesAgo,
          lastOutcome: failure('timeout', null, '60 s'),
        }),
        fr,
        'fr',
        now,
      ),
    ).toBe('En pause après 3 échecs · il y a 2 min · Le script a dépassé 60 s');
    // A reason left from an earlier pause is not shown once it runs again.
    expect(
      automationDetail(
        automation({ stop: { reason: 'deadline', detail: null }, lastRunAt: twoMinutesAgo }),
        en,
        'en',
        now,
      ),
    ).toBe('2 min ago');
  });
});

describe('automation outcome', () => {
  it('lists what the run did, or says it had nothing new', () => {
    expect(outcomeText(success('canvas', 'notify', 'wake'), fr)).toBe(
      'Carte mise à jour · Notification envoyée · Bot réveillé',
    );
    expect(outcomeText(success('wake'), en)).toBe('Bot woken');
    expect(outcomeText(success(), fr)).toBe('Rien de neuf');
    expect(outcomeText(success(), en)).toBe('Nothing new');
  });

  it('words why the run failed, with the exit code', () => {
    expect(outcomeText(failure('exit', 1), fr)).toBe('Le script a échoué (code 1)');
    expect(outcomeText(failure('exit', 2), en)).toBe('The script failed (code 2)');
    expect(outcomeText(failure('exit'), fr)).toBe('Le script a échoué');
    expect(outcomeText(failure('timeout', null, '90 s'), en)).toBe('The script ran over 90 s');
    expect(outcomeText(failure('timeout'), fr)).toBe('Le script a dépassé 60 s');
    expect(outcomeText(failure('output'), fr)).toBe('Sortie JSON invalide');
    expect(outcomeText(failure('no_canvas'), fr)).toBe('Pas de carte à mettre à jour');
    expect(outcomeText(failure('no_computer'), en)).toBe('The bot no longer has a computer');
    expect(outcomeText(failure('other'), fr)).toBe('Erreur');
    expect(outcomeText({ ok: false, actions: [], error: null }, en)).toBe('Error');
  });

  it('keeps the script’s own words to read on demand', () => {
    expect(errorDetail(failure('exit', 1, 'Traceback: KeyError'))).toBe('Traceback: KeyError');
    expect(errorDetail(failure('output', null, 'score Required'))).toBe('score Required');
    // Nothing more to read than the label.
    expect(errorDetail(failure('timeout', null, '60 s'))).toBeNull();
    expect(errorDetail(failure('no_canvas', null, 'canvas'))).toBeNull();
    expect(errorDetail(failure('exit', 1, '  '))).toBeNull();
    expect(errorDetail(success('canvas'))).toBeNull();
    expect(errorDetail(null)).toBeNull();
  });

  it('says why it ended or paused on its own', () => {
    expect(stopText({ reason: 'done', detail: 'Match terminé' }, fr)).toBe(
      'Terminée : Match terminé',
    );
    expect(stopText({ reason: 'done', detail: null }, en)).toBe('Finished');
    expect(stopText({ reason: 'deadline', detail: null }, fr)).toBe('Échéance atteinte');
    expect(stopText({ reason: 'deadline', detail: null }, en)).toBe('Deadline reached');
    expect(stopText({ reason: 'failures', detail: '3' }, fr)).toBe('En pause après 3 échecs');
    expect(stopText({ reason: 'failures', detail: '1' }, en)).toBe('Paused after 1 failure');
    expect(stopText({ reason: 'failures', detail: null }, en)).toBe('Paused');
  });
});

describe('live home cards', () => {
  it('are the ones an active automation updates', () => {
    const list = [
      automation({ canvasId: 'c1' }),
      automation({ canvasId: 'c2', status: 'paused' }),
      automation({ canvasId: 'c3', status: 'stopped' }),
      automation({ canvasId: null }),
    ];
    expect(isCanvasLive(list, 'c1')).toBe(true);
    expect(isCanvasLive(list, 'c2')).toBe(false);
    expect(isCanvasLive(list, 'c3')).toBe(false);
    expect(isCanvasLive([], 'c1')).toBe(false);
  });
});

describe('automation list', () => {
  it('shows running ones first, then paused, then finished, newest first', () => {
    const old = automation({ name: 'old', createdAt: '2026-10-20T10:00:00.000Z' });
    const recent = automation({ name: 'recent', createdAt: '2026-10-21T10:00:00.000Z' });
    const paused = automation({ name: 'paused', status: 'paused' });
    const over = automation({ name: 'over', status: 'stopped' });
    expect(sortAutomations([over, old, paused, recent]).map((a) => a.name)).toEqual([
      'recent',
      'old',
      'paused',
      'over',
    ]);
  });

  it('stays live through events', () => {
    const client = new QueryClient();
    const first = automation();
    client.setQueryData<Automation[]>(keys.automations, [first]);
    const ran = { ...first, runs: 1, lastOutcome: success('canvas') };
    applyServerEvent(client, { type: 'automation.updated', automation: ran });
    const added = automation({ name: 'Prix' });
    applyServerEvent(client, { type: 'automation.updated', automation: added });
    expect(client.getQueryData(keys.automations)).toEqual([ran, added]);
    applyServerEvent(client, { type: 'automation.deleted', automationId: first.id });
    expect(client.getQueryData(keys.automations)).toEqual([added]);
  });
});
