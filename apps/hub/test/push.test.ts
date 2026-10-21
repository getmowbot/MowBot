import type { Bot, Me } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { plainExcerpt } from '../src/push/service';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TOKEN = 'ExponentPushToken[abc123]';

interface Sent {
  to: string;
  title: string;
  body?: string;
  priority: string;
  data: { url: string };
}

/** Stands in for Expo's push service; `tickets` decides what it answers. */
function fakeExpo(tickets: (message: Sent) => object = () => ({ status: 'ok', id: 'x' })) {
  const sent: Sent[] = [];
  const pushFetch = (async (_url: string, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    sent.push(...batch);
    return new Response(JSON.stringify({ data: batch.map(tickets) }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, pushFetch };
}

async function start(
  expo: ReturnType<typeof fakeExpo>,
  model?: MockLanguageModelV4,
  finishedPushAfterMs?: number,
) {
  t = await createTestApp({}, undefined, model ? () => model : undefined, {
    pushFetch: expo.pushFetch,
    finishedPushAfterMs,
  });
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  // No quiet hours, unless a test sets some.
  await inject('PATCH', '/api/v1/system', { quietHours: null });
  /** Pushes go out in the background. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
  return { inject, chef, services, flush };
}

describe('push notifications', () => {
  it('registers the phone and its preferences', async () => {
    const { inject } = await start(fakeExpo());
    const me = await inject<Me>('PUT', '/api/v1/me/push', {
      token: TOKEN,
      prefs: { hideContent: true },
    });
    expect(me.body.device.push).toEqual({
      enabled: true,
      prefs: { finished: true, needsYou: true, notifications: true, hideContent: true },
    });
    const bad = await inject('PUT', '/api/v1/me/push', { token: 'not-a-token' });
    expect(bad.status).toBe(400);
    const off = await inject<Me>('PUT', '/api/v1/me/push', { token: null });
    expect(off.body.device.push.enabled).toBe(false);
  });

  it('tells the phone when a bot needs the user, opening its conversation', async () => {
    const expo = fakeExpo();
    const model = scripted([
      toolTurn('ask_user', { question: 'Je réserve pour 20 h ?', options: ['Oui', 'Non'] }),
      textTurn('Je te laisse choisir.'),
    ]);
    const { inject, chef, services, flush } = await start(expo, model);
    await inject('PUT', '/api/v1/me/push', { token: TOKEN });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Réserve' });
    await services.runtime.settle();
    await flush();
    expect(expo.sent).toEqual([
      {
        to: TOKEN,
        title: 'Chef te pose une question',
        body: 'Je réserve pour 20 h ?',
        sound: 'default',
        priority: 'default',
        data: { url: `/chat/${chef.id}` },
      },
    ]);
  });

  it('says when a long answer is done, words hidden on request', async () => {
    const expo = fakeExpo();
    const model = scripted([textTurn('Voici **le** résumé de la semaine.')]);
    const { inject, chef, services, flush } = await start(expo, model, 0);
    await inject('PUT', '/api/v1/me/push', { token: TOKEN });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Résume' });
    await services.runtime.settle();
    await flush();
    expect(expo.sent.at(-1)).toMatchObject({
      title: 'Chef a fini',
      body: 'Voici le résumé de la semaine.',
    });

    await inject('PUT', '/api/v1/me/push', { prefs: { hideContent: true } });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Encore' });
    await services.runtime.settle();
    await flush();
    expect(expo.sent.at(-1)).toMatchObject({ title: 'Chef a fini' });
    expect(expo.sent.at(-1)).not.toHaveProperty('body');
  });

  it('follows preferences, quiet hours and digests', async () => {
    const expo = fakeExpo();
    const { inject, chef, services, flush } = await start(expo);
    await inject('PUT', '/api/v1/me/push', { token: TOKEN });
    const notify = (priority: 'urgent' | 'normal' | 'digest', title: string) =>
      services.notifications.create({ botId: chef.id, priority, title });

    await notify('digest', 'Pour le bilan');
    await notify('normal', 'Nouvelle offre');
    await flush();
    expect(expo.sent.map((m) => m.title)).toEqual(['Nouvelle offre']);

    await inject('PATCH', '/api/v1/system', { quietHours: { start: '00:00', end: '23:59' } });
    await notify('normal', 'La nuit');
    await notify('urgent', 'Serveur en panne');
    await flush();
    expect(expo.sent.map((m) => [m.title, m.priority])).toEqual([
      ['Nouvelle offre', 'default'],
      ['Serveur en panne', 'high'],
    ]);

    await inject('PUT', '/api/v1/me/push', { prefs: { notifications: false } });
    await notify('urgent', 'Encore une');
    await flush();
    expect(expo.sent).toHaveLength(2);
  });

  it('forgets a phone that no longer takes notifications', async () => {
    const expo = fakeExpo(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } }));
    const { inject, chef, services, flush } = await start(expo);
    await inject('PUT', '/api/v1/me/push', { token: TOKEN });
    await services.notifications.create({ botId: chef.id, priority: 'urgent', title: 'Alerte' });
    await flush();
    const me = await inject<Me>('GET', '/api/v1/me');
    expect(me.body.device.push.enabled).toBe(false);
  });

  it('reads Markdown as plain words', () => {
    expect(plainExcerpt('## Titre\n\nUn **gras** et [un lien](https://x.fr).')).toBe(
      'Titre Un gras et un lien.',
    );
    expect(plainExcerpt('a'.repeat(300)).length).toBe(180);
  });
});
