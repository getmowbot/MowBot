import type { Computer, Team } from '@mowbot/contract';
import { describe, expect, it } from 'vitest';
import { bot, translator } from '../test/fixtures';
import {
  addFallback,
  botChanges,
  botForm,
  botFormChanged,
  botFormError,
  HEARTBEATS,
  heartbeatChoices,
  heartbeatLabel,
  leadChange,
  matchModels,
  moveBody,
  moveUnchanged,
  newBotBody,
  orgChart,
  parseBudget,
  placementOf,
  problemMessage,
  SOLO,
  sortTeams,
  teamChanges,
  teamDeleteBlock,
  teamForm,
  teamMembers,
} from './org-forms';

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    name: 'Veille',
    mission: null,
    isMain: false,
    isolated: false,
    leadBotId: null,
    workspaceId: 'ws-1',
    computerId: 'pc-1',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function computer(overrides: Partial<Computer> = {}): Computer {
  return {
    id: 'pc-1',
    name: 'PC',
    kind: 'team',
    teamId: 'team-1',
    workspaceId: 'ws-1',
    status: 'running',
    statusDetail: null,
    control: null,
    lastActivityAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('org chart', () => {
  const main = team({ id: 'main', name: 'Principale', isMain: true });
  const news = team({ id: 'news', name: 'News', leadBotId: 'iris' });
  const chef = bot({ id: 'chef', name: 'Chef', isChef: true, teamId: 'main' });
  const nova = bot({ id: 'nova', name: 'Nova', teamId: 'news' });
  const iris = bot({ id: 'iris', name: 'Iris', teamId: 'news' });
  const solo = bot({ id: 'solo', name: 'Solo', teamId: null });

  it('puts the main team first, then keeps the hub order', () => {
    const later = team({ id: 'later' });
    expect(sortTeams([news, later, main]).map((t) => t.id)).toEqual(['main', 'news', 'later']);
  });

  it('lists a team’s lead first, then the Chef, then the others', () => {
    expect(teamMembers(news, [nova, chef, iris, solo]).map((b) => b.id)).toEqual(['iris', 'nova']);
    const ledMain = team({ id: 'main', isMain: true, leadBotId: 'nova' });
    const inMain = [bot({ id: 'x', teamId: 'main' }), chef, { ...nova, teamId: 'main' }];
    expect(teamMembers(ledMain, inMain).map((b) => b.id)).toEqual(['nova', 'chef', 'x']);
  });

  it('keeps the Chef apart, every team (even the empty main one) and the solo bots', () => {
    const chart = orgChart([chef, nova, iris, solo], [news, main]);
    expect(chart.chef?.id).toBe('chef');
    expect(
      chart.teams.map(({ team: t, members, size }) => [t.id, members.map((b) => b.id), size]),
    ).toEqual([
      ['main', [], 1],
      ['news', ['iris', 'nova'], 2],
    ]);
    expect(chart.solo.map((b) => b.id)).toEqual(['solo']);
  });
});

describe('bot settings form', () => {
  const current = bot({
    name: 'Nova',
    role: 'Veille',
    mission: 'Surveiller',
    providerId: PROVIDER,
    model: 'gpt-5',
    fallbacks: [{ providerId: OTHER, model: 'kimi' }],
    heartbeatMinutes: 60,
    dailyTokenBudget: 50_000,
  });

  it('changes nothing until the user edits', () => {
    const form = botForm(current, undefined);
    expect(botChanges(current, form)).toEqual({});
    expect(botFormChanged(current, undefined, form)).toBe(false);
  });

  it('sends only what changed, trimmed', () => {
    const form = { ...botForm(current, undefined), name: ' Nova 2 ', mission: '  ', budget: '' };
    expect(botChanges(current, form)).toEqual({
      name: 'Nova 2',
      mission: null,
      dailyTokenBudget: null,
    });
  });

  it('lets the hub pick the default model of a new provider', () => {
    const form = { ...botForm(current, undefined), providerId: OTHER, model: '' };
    expect(botChanges(current, form)).toEqual({ providerId: OTHER });
    expect(botChanges(current, { ...form, model: 'kimi-k2' })).toEqual({
      providerId: OTHER,
      model: 'kimi-k2',
    });
  });

  it('clears provider and model together', () => {
    const form = { ...botForm(current, undefined), providerId: null, model: 'ignored' };
    expect(botChanges(current, form)).toEqual({ providerId: null, model: null });
  });

  it('reads an emptied model name as the provider’s default', () => {
    const form = { ...botForm(current, undefined), model: '' };
    // The default is the current model: nothing to save.
    expect(botChanges(current, form, [{ id: PROVIDER, defaultModel: 'gpt-5' }])).toEqual({});
    // Another default: resending the provider makes the hub apply it.
    expect(botChanges(current, form, [{ id: PROVIDER, defaultModel: 'gpt-4' }])).toEqual({
      providerId: PROVIDER,
    });
  });

  it('compares light and fallback models by value', () => {
    const base = botForm(current, undefined);
    expect(
      botChanges(current, { ...base, lightModel: { providerId: OTHER, model: ' mini ' } }),
    ).toEqual({ lightModel: { providerId: OTHER, model: 'mini' } });
    expect(botChanges(current, { ...base, fallbacks: [] })).toEqual({ fallbacks: [] });
    const reordered = addFallback(base.fallbacks).map((draft, index) =>
      index === 1 ? { ...draft, providerId: PROVIDER, model: 'gpt-5-mini' } : draft,
    );
    expect(botChanges(current, { ...base, fallbacks: reordered })).toEqual({
      fallbacks: [
        { providerId: OTHER, model: 'kimi' },
        { providerId: PROVIDER, model: 'gpt-5-mini' },
      ],
    });
  });

  it('adds fallback rows with fresh ids, five at most', () => {
    let rows = botForm(current, undefined).fallbacks;
    for (let i = 0; i < 6; i++) rows = addFallback(rows);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.id)).size).toBe(5);
  });

  it('refuses what the hub would refuse', () => {
    const base = botForm(current, undefined);
    expect(botFormError(base)).toBeNull();
    expect(botFormError({ ...base, name: ' ' })).toBe('name');
    expect(botFormError({ ...base, role: '' })).toBe('role');
    expect(botFormError({ ...base, budget: '999' })).toBe('budget');
    expect(botFormError({ ...base, lightModel: { providerId: OTHER, model: '' } })).toBe(
      'lightModel',
    );
    expect(botFormError({ ...base, fallbacks: [{ id: 0, providerId: OTHER, model: ' ' }] })).toBe(
      'fallback',
    );
    // A fallback row left without a provider is simply dropped.
    expect(botFormError({ ...base, fallbacks: addFallback([]) })).toBeNull();
  });

  it('changes the team lead only when the switch moved, never for the Chef', () => {
    const led = team({ leadBotId: current.id });
    expect(botForm(current, led).lead).toBe(true);
    expect(leadChange(current, led, true)).toBeUndefined();
    expect(leadChange(current, led, false)).toBeNull();
    expect(leadChange(current, team(), true)).toBe(current.id);
    expect(leadChange(current, undefined, true)).toBeUndefined();
    expect(leadChange(bot({ isChef: true }), team(), true)).toBeUndefined();
    expect(botFormChanged(current, led, { ...botForm(current, led), lead: false })).toBe(true);
  });
});

describe('budget and check-ins', () => {
  it('parses what people type', () => {
    expect(parseBudget('')).toEqual({ ok: true, value: null });
    expect(parseBudget(' 20 000 ')).toEqual({ ok: true, value: 20_000 });
    expect(parseBudget('20,000')).toEqual({ ok: true, value: 20_000 });
    expect(parseBudget('999')).toEqual({ ok: false });
    expect(parseBudget('1e5')).toEqual({ ok: false });
    expect(parseBudget('-5000')).toEqual({ ok: false });
  });

  it('offers the bot’s own rhythm too', () => {
    expect(heartbeatChoices(60)).toEqual([...HEARTBEATS]);
    expect(heartbeatChoices(45)).toEqual([null, 15, 30, 45, 60, 120, 240, 720]);
  });

  it('words the rhythm', async () => {
    const t = await translator('en');
    expect(heartbeatLabel(null, t)).toBe('Off');
    expect(heartbeatLabel(15, t)).toBe('Every 15 minutes');
    expect(heartbeatLabel(60, t)).toBe('Every hour');
    expect(heartbeatLabel(720, t)).toBe('Every 12 hours');
    expect(heartbeatLabel(90, t)).toBe('Every 90 minutes');
  });
});

describe('models', () => {
  const models = ['gpt-5', 'gpt-5-mini', 'o4-mini', 'kimi-k2'];
  it('lists the first models, then filters by what is typed', () => {
    expect(matchModels(models, '', 2)).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(matchModels(models, 'MINI')).toEqual(['o4-mini', 'gpt-5-mini']);
    expect(matchModels(models, 'gpt-5')).toEqual(['gpt-5', 'gpt-5-mini']);
    expect(matchModels(models, 'claude')).toEqual([]);
  });
});

describe('team settings', () => {
  const current = team({ name: 'News', mission: 'Veille', leadBotId: 'iris' });
  it('sends only what changed', () => {
    const form = teamForm(current);
    expect(teamChanges(current, form)).toEqual({});
    expect(
      teamChanges(current, {
        ...form,
        name: ' Actus ',
        mission: '',
        isolated: true,
        leadBotId: null,
      }),
    ).toEqual({ name: 'Actus', mission: null, isolated: true, leadBotId: null });
  });

  it('only deletes an empty team that is not the main one', () => {
    expect(teamDeleteBlock(team({ isMain: true }), 0)).toBe('main');
    expect(teamDeleteBlock(current, 2)).toBe('notEmpty');
    expect(teamDeleteBlock(current, 0)).toBeNull();
  });
});

describe('new bot and move', () => {
  it('builds the new bot body', () => {
    const form = {
      name: ' Nova ',
      role: ' Veille ',
      mission: ' ',
      team: 'news',
      computer: 'dedicated' as const,
      lead: true,
    };
    expect(newBotBody(form)).toEqual({
      name: 'Nova',
      role: 'Veille',
      teamId: 'news',
      computer: 'dedicated',
      lead: true,
    });
    expect(newBotBody({ ...form, team: SOLO, computer: 'team', mission: 'Lire' })).toEqual({
      name: 'Nova',
      role: 'Veille',
      mission: 'Lire',
      teamId: null,
      computer: 'dedicated',
      lead: false,
    });
  });

  it('knows when a move changes nothing', () => {
    const nova = bot({ teamId: 'news', computerId: 'pc-1' });
    const here = placementOf(nova, computer());
    expect(here).toEqual({ team: 'news', computer: 'team' });
    expect(moveUnchanged(here, 'news', 'team')).toBe(true);
    expect(moveUnchanged(here, 'news', 'dedicated')).toBe(false);
    expect(moveUnchanged(here, 'other', 'team')).toBe(false);
    const solo = placementOf(bot({ teamId: null }), computer({ kind: 'dedicated' }));
    expect(moveUnchanged(solo, SOLO, 'team')).toBe(true);
  });

  it('builds the move body', () => {
    expect(moveBody(SOLO, 'team')).toEqual({ teamId: null, computer: 'dedicated' });
    expect(moveBody('news', 'team')).toEqual({ teamId: 'news', computer: 'team' });
  });
});

describe('problem messages', () => {
  it('words the hub’s known problems, else shows its detail or the fallback', async () => {
    const t = await translator('fr');
    const problem = (code: string, detail?: string) => ({
      type: `urn:mowbot:problem:${code}`,
      title: 'Conflict',
      status: 409,
      detail,
    });
    expect(problemMessage(problem('bot_name_taken', 'A bot named "Nova"'), 'x', t)).toBe(
      'Un bot porte déjà ce nom.',
    );
    expect(problemMessage(problem('weird', 'Something odd'), 'x', t)).toBe('Something odd');
    expect(problemMessage(new TypeError('Network request failed'), 'Échec.', t)).toBe('Échec.');
  });
});
