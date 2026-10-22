import type {
  Bot,
  Initiative,
  Memory,
  Message,
  Routine,
  SystemSettings,
  Team,
} from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCH_CRON } from '../src/proactivity/routines';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, scriptedBy, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(models: Record<string, MockLanguageModelV4> = {}) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const call = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await call<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const say = async (botId: string, text: string) => {
    await call('POST', `/api/v1/bots/${botId}/messages`, { text });
    await services.runtime.settle();
  };
  const memories = async () =>
    (await call<{ items: Memory[] }>('GET', '/api/v1/memories')).body.items;
  return { app, services, call, chef, say, memories };
}

describe('the memory', () => {
  it('keeps what a bot hears, for every bot, without asking', async () => {
    const chefModel = scripted([
      toolTurn('remember', {
        fact: 'Son appli de musique est Spotify',
        kind: 'preference',
      }),
      toolTurn(
        'remember',
        {
          fact: 'Compétition de badminton à Rennes',
          kind: 'event',
          at: '2026-11-14T09:00:00+01:00',
        },
        'call-2',
      ),
      toolTurn(
        'remember',
        { fact: 'Son appli de musique est Spotify', kind: 'preference' },
        'call-3',
      ),
      textTurn('Bonne chance pour samedi !'),
    ]);
    const novaModel = scripted([textTurn('Je te prépare une playlist sur Spotify.')]);
    const { call, chef, say, memories, services } = await start({
      Chef: chefModel,
      Nova: novaModel,
    });
    await say(
      chef.id,
      "J'écoute tout sur Spotify, et samedi j'ai ma compétition de badminton à Rennes",
    );

    const kept = await memories();
    // The same fact twice is one memory.
    expect(kept.map((m) => m.text).sort()).toEqual([
      'Compétition de badminton à Rennes',
      'Son appli de musique est Spotify',
    ]);
    const event = kept.find((m) => m.kind === 'event');
    expect(event).toMatchObject({ at: '2026-11-14T08:00:00.000Z', sourceBotId: chef.id });
    expect(promptOf(chefModel, 3)).toContain('Déjà dans la mémoire');

    // Another bot, of another team, reads it.
    const teams = (await call<{ items: Team[] }>('GET', '/api/v1/teams')).body.items;
    const nova = await call<Bot>('POST', '/api/v1/bots', {
      name: 'Nova',
      role: 'Musique',
      teamId: teams[0]?.id,
    });
    await services.runtime.settle();
    await say(nova.body.id, 'Fais-moi une playlist');
    const prompt = promptOf(novaModel, 0);
    expect(prompt).toContain("## Ce que tu sais de l'utilisateur");
    expect(prompt).toContain('(goût) Son appli de musique est Spotify');
    expect(prompt).toContain('Compétition de badminton à Rennes');
    expect(prompt).toContain('Travaille en autonomie');
  });

  it('refuses secrets, and replaces what changed', async () => {
    const model = scriptedBy((prompt, call) => {
      if (call === 0)
        return toolTurn('remember', {
          fact: 'Son mot de passe Gmail est hunter2',
          kind: 'profile',
        });
      if (call === 1)
        return toolTurn(
          'remember',
          { fact: 'Son mail est jo@ancien.fr', kind: 'profile' },
          'call-2',
        );
      if (call === 3) {
        const id = /Retenu \[([0-9a-f]{8})\]/.exec(prompt)?.[1];
        return toolTurn(
          'remember',
          { fact: 'Son mail est jo@nouveau.fr', kind: 'profile', replaces: id },
          'call-4',
        );
      }
      return textTurn('Noté.');
    });
    const { chef, say, memories } = await start({ Chef: model });
    await say(chef.id, 'Mon mail est jo@ancien.fr');
    expect(promptOf(model, 1)).toContain('range-le au coffre');
    expect((await memories()).map((m) => m.text)).toEqual(['Son mail est jo@ancien.fr']);

    await say(chef.id, 'Mon mail a changé : jo@nouveau.fr');
    expect((await memories()).map((m) => m.text)).toEqual(['Son mail est jo@nouveau.fr']);
  });

  it('is the user’s to read, fix and empty', async () => {
    const { call, memories } = await start();
    const created = await call<Memory>('POST', '/api/v1/memories', {
      kind: 'profile',
      text: 'Né le 3 mars 1995',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sourceBotId: null, kind: 'profile' });
    const fixed = await call<Memory>('PATCH', `/api/v1/memories/${created.body.id}`, {
      text: 'Né le 3 mars 1994',
    });
    expect(fixed.body.text).toBe('Né le 3 mars 1994');
    expect((await call('DELETE', `/api/v1/memories/${created.body.id}`)).status).toBe(204);
    expect(await memories()).toEqual([]);
  });
});

describe('initiatives', () => {
  it('are planned by a bot on its own, kept out of the routines, and come back when due', async () => {
    const model = scripted([
      toolTurn('plan_initiative', {
        at: '2099-11-13T19:00:00+01:00',
        what: 'Lui rappeler de se reposer et lui donner l’itinéraire pour Rennes',
      }),
      textTurn('Bonne chance !'),
      textTurn('Repose-toi bien, voici l’itinéraire.'),
    ]);
    const { call, chef, say, services } = await start({ Chef: model });
    await say(chef.id, 'Samedi j’ai ma compétition à Rennes');

    const shown = (await call<{ items: Routine[] }>('GET', '/api/v1/routines')).body.items;
    expect(shown.some((r) => r.kind === 'initiative' || r.kind === 'watch')).toBe(false);
    const [planned] = (await call<{ items: Initiative[] }>('GET', '/api/v1/initiatives')).body
      .items;
    expect(planned).toMatchObject({
      botId: chef.id,
      what: 'Lui rappeler de se reposer et lui donner l’itinéraire pour Rennes',
      at: '2099-11-13T18:00:00.000Z',
    });

    await services.scheduler.fire(await services.routines.row(planned?.id as string));
    await services.runtime.settle();
    expect(promptOf(model, 2)).toContain("[Initiative que tu avais prévue pour l'utilisateur");
    const messages = (await call<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`))
      .body.items;
    expect(messages.at(-1)?.parts.at(-1)).toMatchObject({
      text: 'Repose-toi bien, voici l’itinéraire.',
    });

    // The user cancels what is left.
    const second = await services.routines.planInitiative(
      chef,
      '2099-12-01T08:00:00Z',
      'Autre chose',
    );
    expect((await call('DELETE', `/api/v1/initiatives/${second.id}`)).status).toBe(204);
    const left = (await call<{ items: Initiative[] }>('GET', '/api/v1/initiatives')).body.items;
    expect(left.map((i) => i.id)).not.toContain(second.id);
  });
});

describe('the watch', () => {
  it('has the Chef look after the user twice a day by default, at the pace the user sets', async () => {
    const { call, chef, services } = await start();
    const watch = async () =>
      (await services.routines.list(chef.id)).find((r) => r.kind === 'watch');
    expect((await call<SystemSettings>('GET', '/api/v1/system')).body.watch).toBe('light');
    expect((await watch())?.trigger).toEqual({ type: 'cron', expr: WATCH_CRON.light });

    await call('PATCH', '/api/v1/system', { watch: 'active' });
    expect((await watch())?.trigger).toEqual({ type: 'cron', expr: WATCH_CRON.active });
    await call('PATCH', '/api/v1/system', { watch: 'off' });
    expect(await watch()).toBeUndefined();
  });
});
