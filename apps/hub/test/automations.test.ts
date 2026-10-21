import type { Automation, Bot, Canvas, Message } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOutput } from '../src/proactivity/automations';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const score = (home: number, away: number, status: string) =>
  JSON.stringify({
    canvas: {
      content: {
        kind: 'score',
        home: { name: 'PSG' },
        away: { name: 'OM' },
        home_score: home,
        away_score: away,
        status,
      },
    },
  });

async function start(model: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, () => model);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const say = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const list = async () =>
    (await inject<{ items: Automation[] }>('GET', '/api/v1/automations')).body.items;
  const canvas = async () =>
    (await inject<{ items: Canvas[] }>('GET', '/api/v1/canvases')).body.items[0];
  const transcript = async () =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
  return { inject, chef, say, list, canvas, transcript, services, runtime };
}

/** The Chef pins a score (the user asked), then hands its updates to an automation. */
const setup = () =>
  scripted([
    toolTurn('canvas_set', {
      key: 'psg-om',
      title: 'PSG – OM en direct',
      content: {
        kind: 'score',
        home: { name: 'PSG' },
        away: { name: 'OM' },
        home_score: 0,
        away_score: 0,
        status: 'Coup d’envoi',
      },
    }),
    toolTurn(
      'automation_create',
      {
        name: 'Score PSG-OM',
        command: 'python3 bots/chef/score.py',
        every_seconds: 30,
        canvas: 'psg-om',
      },
      'call-2',
    ),
    textTurn('Le score se mettra à jour tout seul.'),
    textTurn('Ok.'),
  ]);

describe('automation output', () => {
  it('reads the last JSON line, and says what is wrong', () => {
    expect(parseOutput('fetching…\n{"notify": {"title": "But !"}}\n')).toEqual({
      notify: { title: 'But !', priority: 'normal' },
    });
    expect(parseOutput('{}')).toEqual({});
    expect(() => parseOutput('no json here')).toThrow(/aucun objet JSON/);
    expect(() => parseOutput('{"notify": {}}')).toThrow(/notify.title/);
  });
});

describe('automations', () => {
  it('keep a canvas up to date without waking the bot, and end by themselves', async () => {
    const model = setup();
    const { say, list, canvas, transcript, services, runtime } = await start(model);
    let output = score(1, 0, '12e');
    runtime.shell = (script) =>
      script.includes('score.py') ? { stdout: `log\n${output}` } : undefined;

    await say('Suis le match en direct sur l’accueil');
    expect((await canvas())?.content).toMatchObject({ homeScore: 1, awayScore: 0, status: '12e' });
    const [automation] = await list();
    expect(automation).toMatchObject({
      name: 'Score PSG-OM',
      status: 'active',
      runs: 1,
      lastResult: 'canvas mis à jour',
      intervalSeconds: 30,
    });
    const calls = model.doStreamCalls.length;

    // Not due yet; then due.
    output = score(2, 1, '67e');
    await services.automations.tick(new Date());
    await services.automations.tick(new Date(Date.now() + 31_000));
    await vi.waitFor(async () => expect((await list())[0]?.runs).toBe(2));
    expect((await canvas())?.content).toMatchObject({ homeScore: 2, awayScore: 1 });

    output = JSON.stringify({ ...JSON.parse(score(3, 1, 'Terminé')), done: 'Match terminé' });
    await services.automations.run(automation?.id ?? '');
    expect((await list())[0]).toMatchObject({ status: 'stopped', stoppedReason: 'Match terminé' });
    expect((await canvas())?.content).toMatchObject({ homeScore: 3, status: 'Terminé' });
    // The bot was never woken: it only has a note for later.
    await services.runtime.settle();
    expect(model.doStreamCalls.length).toBe(calls);
    expect(JSON.stringify((await transcript()).at(-1))).toContain('Match terminé');
  });

  it('pause after repeated failures and tell the bot', async () => {
    const model = setup();
    const { say, list, services, runtime } = await start(model);
    runtime.shell = (script) =>
      script.includes('score.py')
        ? { exitCode: 1, stderr: 'ModuleNotFoundError: requests' }
        : undefined;
    await say('Suis le match');
    const [automation] = await list();
    expect(automation?.lastResult).toContain('ModuleNotFoundError');
    await services.automations.run(automation?.id ?? '');
    await services.automations.run(automation?.id ?? '');
    expect((await list())[0]).toMatchObject({ status: 'paused', failures: 3 });
    await services.runtime.settle();
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain('en pause après 3 échecs');
  });

  it('notify the user and wake the bot when the script says so', async () => {
    const model = setup();
    const { say, list, inject, services, runtime } = await start(model);
    runtime.shell = (script) =>
      script.includes('score.py')
        ? {
            stdout: JSON.stringify({
              notify: { title: 'But du PSG', priority: 'urgent' },
              wake: 'Mbappé a marqué',
            }),
          }
        : undefined;
    await say('Suis le match');
    await services.runtime.settle();
    const notices = await inject<{ items: { title: string }[] }>('GET', '/api/v1/notifications');
    expect(notices.body.items.map((n) => n.title)).toContain('But du PSG');
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain('Mbappé a marqué');
    expect((await list())[0]?.lastResult).toBe('notification « But du PSG », bot réveillé');
  });

  it('can be paused, resumed and deleted by the user, and go with their canvas', async () => {
    const model = setup();
    const { say, list, inject, canvas, runtime, services } = await start(model);
    runtime.shell = (script) => (script.includes('score.py') ? { stdout: '{}' } : undefined);
    await say('Suis le match');
    const [automation] = await list();
    const paused = await inject<Automation>('PATCH', `/api/v1/automations/${automation?.id}`, {
      status: 'paused',
    });
    expect(paused.body.status).toBe('paused');
    // Nothing runs while the instance is paused.
    await inject('PATCH', `/api/v1/automations/${automation?.id}`, { status: 'active' });
    await inject('PATCH', '/api/v1/system', { paused: true });
    await services.automations.tick(new Date(Date.now() + 60_000));
    expect((await list())[0]?.runs).toBe(1);
    await inject('PATCH', '/api/v1/system', { paused: false });

    // The user takes the card off the home page: the automation goes with it.
    await inject('DELETE', `/api/v1/canvases/${(await canvas())?.id}`);
    expect(await list()).toEqual([]);
  });
});
