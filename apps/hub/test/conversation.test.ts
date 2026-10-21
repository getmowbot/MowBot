import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { Bot, Canvas, Message, MessagePart, Team } from '@mowbot/contract';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotRow } from '../src/bots/service';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, type Turn, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(modelFor: (bot: BotRow) => MockLanguageModelV4 | null) {
  t = await createTestApp({}, undefined, modelFor);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const transcript = async (botId = chef.id) =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${botId}/messages`)).body.items;
  return { inject, chef, transcript, services };
}

/** A model that stays busy until its run is stopped. */
function busyModel() {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          abortSignal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          );
        },
      }),
    }),
  });
}

describe('messages that arrive while a bot works', () => {
  it('join its answer at the next step instead of waiting for another turn', async () => {
    let send: ((text: string) => Promise<unknown>) | null = null;
    let call = 0;
    const turns: Turn[] = [
      toolTurn('canvas_list', {}),
      textTurn('D’accord, je cherche plutôt des chaussures de trail.'),
      textTurn('Toujours là.'),
    ];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // The user writes again while the bot is busy with its first step.
        if (call === 0) await send?.('En fait, plutôt pour le trail');
        return { stream: simulateReadableStream({ chunks: turns[Math.min(call++, 2)] ?? [] }) };
      },
    });
    const { inject, chef, transcript, services } = await start(() => model);
    send = (text) => services.runtime.send(chef.id, text);

    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Trouve-moi des chaussures' });
    await services.runtime.settle();

    expect(promptOf(model, 1)).toContain(
      '[Arrivé pendant que tu travaillais]\\nEn fait, plutôt pour le trail',
    );
    const messages = await transcript();
    expect(messages.map((m) => [m.role, m.steered])).toEqual([
      ['user', false],
      ['assistant', false],
      ['user', true],
    ]);
    // One answer for both: the second message did not start another turn.
    expect(model.doStreamCalls).toHaveLength(2);

    // Later turns read it where it came in, once.
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Tu es là ?' });
    await services.runtime.settle();
    const later = promptOf(model, 2);
    expect(later.split('plutôt pour le trail')).toHaveLength(2);
    expect(later.indexOf('plutôt pour le trail')).toBeLessThan(
      later.indexOf('chaussures de trail'),
    );
  });
});

describe('a bot stopping another', () => {
  it('stops it, leaves it a note and does not wake it up', async () => {
    const chefModel = scripted([
      toolTurn('stop_bot', { bot: 'Léa', reason: 'Nova fait déjà cette recherche' }),
      textTurn('C’est fait.'),
    ]);
    const lea = busyModel();
    const { inject, chef, transcript, services } = await start((bot) =>
      bot.isChef ? chefModel : lea,
    );
    const teams = (await inject<{ items: Team[] }>('GET', '/api/v1/teams')).body.items;
    const created = await inject<Bot>('POST', '/api/v1/bots', {
      name: 'Léa',
      role: 'Recherche',
      teamId: teams[0]?.id,
    });
    expect(created.status).toBe(201);
    await inject('POST', `/api/v1/bots/${created.body.id}/messages`, { text: 'Cherche des vols' });
    // Léa is busy when the Chef steps in.
    await expect.poll(() => lea.doStreamCalls.length).toBe(1);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Arrête Léa' });
    await services.runtime.settle();

    expect(JSON.stringify(await transcript())).toContain('J’ai arrêté Léa.');
    const hers = await transcript(created.body.id);
    expect(hers.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'stopped'],
      ['user', 'done'],
    ]);
    expect(hers[2]).toMatchObject({
      fromName: 'Chef',
      parts: [{ type: 'text', text: '**Arrêté par Chef** · Nova fait déjà cette recherche' }],
    });
    expect(lea.doStreamCalls).toHaveLength(1);
  });
});

describe('canvases in the conversation', () => {
  const card = {
    kind: 'card',
    title: 'Trail X-Pro',
    subtitle: '89,90 € · Decathlon',
    image: 'https://shop.example/x-pro.jpg',
    url: 'https://shop.example/x-pro',
    buttons: [
      { label: 'Acheter', url: 'https://shop.example/x-pro', reply: 'Je les prends' },
      { label: 'Rien faire' },
    ],
  };

  it('shows a card in the answer, and its buttons answer the bot', async () => {
    const model = scripted([
      toolTurn('show_in_chat', { content: card }),
      textTurn('Celles-ci sont légères et bien notées.'),
      textTurn('Parfait, je te laisse finaliser sur le site.'),
    ]);
    const { inject, chef, transcript, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Des chaussures de trail ?' });
    await services.runtime.settle();

    const answer = (await transcript()).find((m) => m.role === 'assistant') as Message;
    expect(answer.parts).toEqual([
      {
        type: 'canvas',
        content: { ...card, buttons: card.buttons },
        pressed: null,
      },
      { type: 'text', text: 'Celles-ci sont légères et bien notées.' },
    ]);

    const pressed = await inject<Message>(
      'POST',
      `/api/v1/bots/${chef.id}/messages/${answer.id}/press`,
      { part: 0, button: 0 },
    );
    expect(pressed.body.parts[0]).toMatchObject({ pressed: 'Acheter' });
    await services.runtime.settle();
    expect(promptOf(model, 2)).toContain(
      '[Bouton « Acheter » de ta carte « Trail X-Pro »]\\nJe les prends',
    );
    const messages = await transcript();
    expect(messages.at(-2)?.parts).toEqual([{ type: 'text', text: 'Acheter' }]);

    const again = await inject('POST', `/api/v1/bots/${chef.id}/messages/${answer.id}/press`, {
      part: 0,
      button: 1,
    });
    expect(again.status).toBe(409);
  });

  it('refuses links that would not open a web page', async () => {
    const model = scripted([
      toolTurn('show_in_chat', {
        content: { kind: 'card', title: 'Piège', url: 'javascript:alert(1)' },
      }),
      textTurn('Raté.'),
    ]);
    const { inject, chef, transcript, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Montre' });
    await services.runtime.settle();
    const answer = (await transcript()).find((m) => m.role === 'assistant') as Message;
    expect(answer.parts.some((p) => p.type === 'canvas')).toBe(false);
  });

  it('lets a home page card answer the bot that pinned it', async () => {
    const model = scripted([
      toolTurn('canvas_set', {
        key: 'billets',
        title: 'Billets du concert',
        content: { kind: 'card', title: 'Concert samedi', buttons: [{ label: 'Réserver' }] },
      }),
      textTurn('Épinglé.'),
      textTurn('Je réserve.'),
    ]);
    const { inject, chef, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Épingle-le' });
    await services.runtime.settle();
    const [canvas] = (await inject<{ items: Canvas[] }>('GET', '/api/v1/canvases')).body.items;
    expect(canvas?.content).toMatchObject({ kind: 'card', buttons: [{ label: 'Réserver' }] });

    const res = await inject('POST', `/api/v1/canvases/${canvas?.id}/press`, { button: 0 });
    expect(res.status).toBe(204);
    await services.runtime.settle();
    expect(promptOf(model, 2)).toContain(
      '[Bouton « Réserver » de ton canvas « Billets du concert »]',
    );
  });
});

describe('asking for a login in the conversation', () => {
  it('puts what the user types straight into the vault, never in the conversation', async () => {
    const model = scripted([
      toolTurn('vault_request', {
        kind: 'login',
        service: 'BadNet',
        account: 'joris@example.com',
        sites: ['badnet.fr'],
        reason: 'Pour réserver un terrain',
      }),
      textTurn('Dès que c’est rangé, je réserve.'),
      textTurn('Merci, je me connecte.'),
    ]);
    const { inject, chef, transcript, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Réserve un terrain' });
    await services.runtime.settle();

    const answer = (await transcript()).find((m) => m.role === 'assistant') as Message;
    expect(answer.parts[0]).toEqual({
      type: 'vault_request',
      kind: 'login',
      service: 'BadNet',
      account: 'joris@example.com',
      sites: ['badnet.fr'],
      fields: ['username', 'password'],
      reason: 'Pour réserver un terrain',
      itemId: null,
      status: 'pending',
    });

    const saved = await inject<Message>(
      'POST',
      `/api/v1/bots/${chef.id}/messages/${answer.id}/vault-request`,
      { part: 0, values: { username: 'joris', password: 'badnet-pass-1234', totp: 'ignored' } },
    );
    expect(saved.body.parts[0]).toMatchObject({ status: 'saved' });
    await services.runtime.settle();

    const [item] = await services.vault.list();
    expect(item).toMatchObject({ service: 'BadNet', fields: ['username', 'password'] });
    expect(saved.body.parts[0]).toMatchObject({ itemId: item?.id });
    // Neither the conversation nor the model ever saw the password.
    expect(JSON.stringify(await transcript())).not.toContain('badnet-pass-1234');
    expect(promptOf(model, 2)).not.toContain('badnet-pass-1234');
    expect(promptOf(model, 2)).toContain(`{{vault:${item?.ref}.password}}`);

    const again = await inject(
      'POST',
      `/api/v1/bots/${chef.id}/messages/${answer.id}/vault-request`,
      { part: 0, declined: true },
    );
    expect(again.status).toBe(409);
  });
});

describe('asking the user to take control of the computer', () => {
  it('shows a card that follows the takeover, and wakes the bot when control comes back', async () => {
    const model = scripted([
      toolTurn('request_takeover', { reason: 'Connecte-toi à BadNet' }),
      textTurn('Je t’attends sur le PC.'),
      textTurn('Merci, je reprends la réservation.'),
    ]);
    const { inject, chef, transcript, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Réserve un terrain' });
    await services.runtime.settle();

    const computerId = chef.computerId as string;
    const card = async () =>
      (await transcript()).find((m) => m.role === 'assistant')?.parts[0] as MessagePart;
    expect(await card()).toEqual({
      type: 'takeover_request',
      computerId,
      reason: 'Connecte-toi à BadNet',
      url: null,
      status: 'pending',
    });
    const answer = (await transcript()).find((m) => m.role === 'assistant') as Message;
    expect(answer.parts.some((p) => p.type === 'tool')).toBe(false);

    await inject('POST', `/api/v1/computers/${computerId}/takeover`);
    await services.runtime.settle();
    expect(await card()).toMatchObject({ status: 'taken' });
    // Taking control does not wake the bot: it waits for the hand-back.
    expect(model.doStreamCalls).toHaveLength(2);

    await inject('DELETE', `/api/v1/computers/${computerId}/takeover`);
    await services.runtime.settle();
    expect(await card()).toMatchObject({ status: 'returned' });
    expect(model.doStreamCalls).toHaveLength(3);
    expect(promptOf(model, 2)).toContain("[Prise en main] L'utilisateur t'a rendu la main");
    const messages = await transcript();
    expect(messages.at(-2)?.parts).toEqual([{ type: 'text', text: expect.stringContaining('🖱️') }]);
    expect(messages.at(-1)?.parts).toEqual([
      { type: 'text', text: 'Merci, je reprends la réservation.' },
    ]);
  });
});

describe('presenting a file in the conversation', () => {
  it('shows the file with its name and size, and refuses paths outside the workspace', async () => {
    const model = scripted([
      toolTurn('write_file', {
        path: '/workspace/outputs/rapport.md',
        content: '# Rapport\n\nTout va bien.\n',
      }),
      toolTurn(
        'show_in_chat',
        {
          content: {
            kind: 'file',
            path: '/workspace/outputs/rapport.md',
            caption: 'Le rapport de la semaine',
          },
        },
        'call-2',
      ),
      toolTurn('show_in_chat', { content: { kind: 'file', path: '/etc/passwd' } }, 'call-3'),
      textTurn('Voici le rapport.'),
    ]);
    const { inject, chef, transcript, services } = await start(() => model);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Fais le rapport' });
    await services.runtime.settle();

    const answer = (await transcript()).find((m) => m.role === 'assistant') as Message;
    const shown = answer.parts.filter((p) => p.type === 'canvas');
    expect(shown).toEqual([
      {
        type: 'canvas',
        content: {
          kind: 'file',
          path: 'outputs/rapport.md',
          name: 'rapport.md',
          type: 'file',
          size: 25,
          caption: 'Le rapport de la semaine',
        },
        pressed: null,
      },
    ]);
    expect(promptOf(model, 3)).toContain('Seuls les fichiers de /workspace');
  });
});
