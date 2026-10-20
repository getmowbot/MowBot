import type { Bot, Canvas, Message } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(chefModel?: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, () => chefModel ?? null);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const ask = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const home = async () =>
    (await inject<{ items: Canvas[] }>('GET', '/api/v1/canvases')).body.items;
  return { inject, chef, ask, home, services };
}

const score = (homeScore: number) => ({
  key: 'psg-dernier-match',
  title: 'PSG',
  size: 'm',
  content: {
    kind: 'score',
    home: { name: 'PSG', logo: '/workspace/bots/chef/logos/psg.png' },
    away: { name: 'Monaco', logo: 'bots/chef/logos/monaco.png' },
    home_score: homeScore,
    away_score: 1,
    status: 'Terminé',
    detail: 'Ligue 1 · 9e journée',
  },
});

describe('canvases', () => {
  it('lets a bot pin a card and keep it up to date under the same key', async () => {
    const { ask, home } = await start(
      scripted([
        toolTurn('canvas_set', score(2), 'a'),
        toolTurn('canvas_set', score(3), 'b'),
        textTurn('Score affiché.'),
      ]),
    );
    await ask('Suis le PSG');
    const cards = await home();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      key: 'psg-dernier-match',
      size: 'm',
      hidden: false,
      content: {
        kind: 'score',
        home: { name: 'PSG', logo: 'bots/chef/logos/psg.png' },
        away: { name: 'Monaco', logo: 'bots/chef/logos/monaco.png' },
        homeScore: 3,
        awayScore: 1,
      },
    });
  });

  it('keeps the page tidy: at most four cards per bot', async () => {
    const turns = [1, 2, 3, 4, 5].map((n) =>
      toolTurn(
        'canvas_set',
        { key: `carte-${n}`, title: `Carte ${n}`, content: { kind: 'note', markdown: 'x' } },
        `c${n}`,
      ),
    );
    const { ask, home, inject, chef } = await start(scripted([...turns, textTurn('Ok.')]));
    await ask('Remplis la page');
    expect(await home()).toHaveLength(4);
    const answer = (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`))
      .body.items[1];
    const refused = answer?.parts.find((p) => p.type === 'tool' && p.state === 'error');
    expect(refused?.type === 'tool' && refused.output).toContain('4 canvas');
  });

  it('keeps what the user ticked when the bot updates a list', async () => {
    const list = (items: string[]) => ({
      key: 'courses',
      title: 'Courses',
      content: { kind: 'checklist', items: items.map((text) => ({ text })) },
    });
    const { ask, home, inject } = await start(
      scripted([
        toolTurn('canvas_set', list(['Lait', 'Pain']), 'a'),
        textTurn('Liste prête.'),
        toolTurn('canvas_set', list(['Lait', 'Pain', 'Œufs']), 'b'),
        textTurn('Ajouté.'),
      ]),
    );
    await ask('Fais une liste de courses');
    const [canvas] = await home();
    const milk =
      canvas?.content.kind === 'checklist'
        ? canvas.content.items.find((i) => i.text === 'Lait')
        : null;
    const ticked = await inject<Canvas>(
      'PATCH',
      `/api/v1/canvases/${canvas?.id}/items/${milk?.id}`,
      {
        done: true,
      },
    );
    expect(ticked.status).toBe(200);
    await inject('POST', `/api/v1/canvases/${canvas?.id}/items`, { text: 'Café' });

    await ask('Ajoute des œufs');
    const [updated] = await home();
    expect(updated?.content).toMatchObject({
      kind: 'checklist',
      items: [
        { text: 'Lait', done: true },
        { text: 'Pain', done: false },
        { text: 'Œufs', done: false },
      ],
    });
  });

  it('lets the user arrange the page and remove a card the bot then leaves alone', async () => {
    const note = (key: string) => ({ key, title: key, content: { kind: 'note', markdown: key } });
    const { ask, home, inject } = await start(
      scripted([
        toolTurn('canvas_set', note('un'), 'a'),
        toolTurn('canvas_set', note('deux'), 'b'),
        textTurn('Ok.'),
        toolTurn('canvas_set', note('un'), 'c'),
        textTurn('Mis à jour.'),
      ]),
    );
    await ask('Deux notes');
    const [first, second] = await home();
    await inject('PUT', '/api/v1/canvases/order', { ids: [second?.id, first?.id] });
    expect((await home()).map((c) => c.key)).toEqual(['deux', 'un']);

    const resized = await inject<Canvas>('PATCH', `/api/v1/canvases/${first?.id}`, {
      size: 'l',
      hidden: true,
    });
    expect(resized.body).toMatchObject({ size: 'l', hidden: true });
    await ask('Mets à jour la première');
    expect((await home()).find((c) => c.key === 'un')?.hidden).toBe(true);

    expect((await inject('DELETE', `/api/v1/canvases/${second?.id}`)).status).toBe(204);
    expect((await home()).map((c) => c.key)).toEqual(['un']);
  });
});
