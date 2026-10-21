import type { Automation } from '@mowbot/contract';
import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { automation, translator } from '../test/fixtures';
import {
  automationDetail,
  automationStatusLabel,
  automationTone,
  isCanvasLive,
  rhythmText,
  sortAutomations,
  untilText,
} from './automations';
import { applyServerEvent } from './event-cache';
import { keys } from './query-keys';

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
        automation({ lastRunAt: twoMinutesAgo, lastResult: '2-1 (67’)' }),
        fr,
        'fr',
        now,
      ),
    ).toBe('il y a 2 min · 2-1 (67’)');
    expect(
      automationDetail(
        automation({
          status: 'stopped',
          stoppedReason: 'Match terminé',
          lastRunAt: twoMinutesAgo,
          lastResult: '3-1',
        }),
        en,
        'en',
        now,
      ),
    ).toBe('Match terminé · 2 min ago · 3-1');
    // A reason left from an earlier pause is not shown once it runs again.
    expect(
      automationDetail(
        automation({ stoppedReason: 'old', lastRunAt: twoMinutesAgo }),
        en,
        'en',
        now,
      ),
    ).toBe('2 min ago');
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
    const ran = { ...first, runs: 1, lastResult: '1-0' };
    applyServerEvent(client, { type: 'automation.updated', automation: ran });
    const added = automation({ name: 'Prix' });
    applyServerEvent(client, { type: 'automation.updated', automation: added });
    expect(client.getQueryData(keys.automations)).toEqual([ran, added]);
    applyServerEvent(client, { type: 'automation.deleted', automationId: first.id });
    expect(client.getQueryData(keys.automations)).toEqual([added]);
  });
});
