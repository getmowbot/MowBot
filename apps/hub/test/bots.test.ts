import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Bot, Message, ServerEvent } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../src/db/schema';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(model?: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, model ? () => model : undefined);
  const token = (await setupOwner(t.app)).accessToken;
  const app = t.app;
  const chef: Bot = (
    await app.inject({ method: 'GET', url: '/api/v1/bots', headers: bearer(token) })
  ).json().items[0];
  const events: ServerEvent[] = [];
  t.services.events.subscribe((event) => events.push(event));
  const send = (text: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: bearer(token),
      payload: { text },
    });
  const conversation = async (): Promise<Message[]> =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${chef.id}/messages`,
        headers: bearer(token),
      })
    ).json().items;
  return { app, token, chef, events, send, conversation, services: t.services, testApp: t };
}

describe('Chef', () => {
  it('exists after setup, in the main team, on its PC', async () => {
    const { chef, app, token } = await start();
    const team = (
      await app.inject({ method: 'GET', url: '/api/v1/teams', headers: bearer(token) })
    ).json().items[0];
    expect(chef).toMatchObject({
      name: 'Chef',
      isChef: true,
      teamId: team.id,
      computerId: team.computerId,
      workspaceId: team.workspaceId,
      providerId: null,
      status: 'idle',
    });
    expect(chef.avatarSeed.length).toBeGreaterThan(4);
  });

  it('explains that no model is configured', async () => {
    const { send, conversation, services, chef } = await start();
    expect((await send('Bonjour')).statusCode).toBe(202);
    await services.runtime.idle(chef.id);
    const [user, answer] = await conversation();
    expect(user).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Bonjour' }] });
    expect(answer).toMatchObject({ role: 'assistant', status: 'error' });
    expect(answer?.errorCode).toBe('no_model');
  });
});

describe('providers', () => {
  it('stores keys sealed, assigns the first provider to the Chef and lists models', async () => {
    const models = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const ok = req.headers.authorization === 'Bearer sk-test' && req.headers['x-cmd-zdr'] === '1';
      if (req.url === '/v1/models' && ok) {
        res.end(JSON.stringify({ data: [{ id: 'mow-large' }, { id: 'mow-mini' }] }));
      } else {
        res.statusCode = 401;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1/`;
    try {
      const { app, token, chef } = await start();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers: bearer(token),
        payload: {
          name: 'Local',
          kind: 'openai-compatible',
          baseUrl,
          apiKey: 'sk-test',
          defaultModel: 'mow-mini',
          headers: { 'x-cmd-zdr': '1' },
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        hasApiKey: true,
        baseUrl: baseUrl.slice(0, -1),
        headers: { 'x-cmd-zdr': '1' },
      });
      expect(created.body).not.toContain('sk-test');

      const updatedChef = (
        await app.inject({ method: 'GET', url: `/api/v1/bots/${chef.id}`, headers: bearer(token) })
      ).json();
      expect(updatedChef).toMatchObject({ providerId: created.json().id, model: 'mow-mini' });

      const listed = await app.inject({
        method: 'GET',
        url: `/api/v1/providers/${created.json().id}/models`,
        headers: bearer(token),
      });
      expect(listed.json()).toEqual({ items: [{ id: 'mow-large' }, { id: 'mow-mini' }] });
    } finally {
      await new Promise((resolve) => models.close(resolve));
    }
  });

  it('fills the base URL of presets and requires one otherwise', async () => {
    const { app, token } = await start();
    const preset = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: bearer(token),
      payload: { name: 'Command Code', kind: 'command-code', apiKey: 'x' },
    });
    expect(preset.json().baseUrl).toBe('https://api.commandcode.ai/provider/v1');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: bearer(token),
      payload: { name: 'Nope', kind: 'openai-compatible' },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('validates and replaces custom headers', async () => {
    const { app, token } = await start();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/providers',
        headers: bearer(token),
        payload: { name: 'CC', kind: 'command-code', headers: { 'x-a': '1', 'x-b': '2' } },
      })
    ).json();
    const bad = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${created.id}`,
      headers: bearer(token),
      payload: { headers: { 'bad header': 'x' } },
    });
    expect(bad.statusCode).toBe(400);
    const injected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${created.id}`,
      headers: bearer(token),
      payload: { headers: { 'x-a': 'ok\r\nx-evil: 1' } },
    });
    expect(injected.statusCode).toBe(400);
    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${created.id}`,
      headers: bearer(token),
      payload: { headers: { 'x-cmd-zdr': '1' } },
    });
    expect(replaced.json().headers).toEqual({ 'x-cmd-zdr': '1' });
  });
});

describe('conversation', () => {
  it('starts over: stops the bot, deletes its messages, keeps its files', async () => {
    const model = scripted([textTurn('un deux trois quatre cinq six')], 60);
    const { send, conversation, services, chef, app, token, events } = await start(model);
    await send('Compte');
    await vi.waitFor(async () => {
      expect((await conversation()).at(-1)?.status).toBe('streaming');
    });
    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: bearer(token),
    });
    expect(cleared.statusCode).toBe(204);
    expect(await conversation()).toEqual([]);
    expect(events).toContainEqual({ type: 'messages.cleared', botId: chef.id });
    expect((await services.bots.row(chef.id)).status).toBe('idle');
  });

  it('moves the bot folder and its screenshot links on rename', async () => {
    const model = scripted([toolTurn('screenshot', {}), textTurn('Vu.')]);
    const { send, conversation, services, chef, app, token } = await start(model);
    await send('Regarde');
    await services.runtime.idle(chef.id);
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/bots/${chef.id}`,
      headers: bearer(token),
      payload: { name: 'Max Ölberg' },
    });
    expect(renamed.json().name).toBe('Max Ölberg');
    const shot = (await conversation())[1]?.parts[0];
    const shotPath = shot?.type === 'tool' ? shot.image?.path : undefined;
    expect(shotPath).toMatch(/^bots\/max-olberg\/captures\/.+\.png$/);
    await expect(
      services.files.stat(chef.workspaceId as string, shotPath as string),
    ).resolves.toMatchObject({ type: 'file' });
  });
});

describe('runtime', () => {
  it('runs tools on the PC, streams the answer and keeps the transcript', async () => {
    const model = scripted([
      toolTurn('bash', { command: 'echo bonjour' }),
      textTurn('Terminé, tout va bien.'),
    ]);
    const { send, conversation, services, chef, events, testApp } = await start(model);

    await send('Dis bonjour depuis ton PC');
    await services.runtime.idle(chef.id);

    const [, answer] = await conversation();
    expect(answer).toMatchObject({
      role: 'assistant',
      status: 'done',
      usage: { inputTokens: 24, outputTokens: 14 },
    });
    expect(answer?.parts[0]).toMatchObject({ type: 'tool', toolName: 'bash', state: 'done' });
    expect(answer?.parts[0]?.type === 'tool' && answer.parts[0].output).toContain('$ echo bonjour');
    expect(answer?.parts[1]).toEqual({ type: 'text', text: 'Terminé, tout va bien.' });

    // The PC was started on demand.
    expect(await testApp.runtime.isRunning(`fake-${chef.computerId}`)).toBe(true);
    expect(events.some((e) => e.type === 'message.delta' && e.text.includes('Terminé'))).toBe(true);
    const statuses = events
      .filter((e) => e.type === 'bot.updated')
      .map((e) => e.type === 'bot.updated' && e.bot.status);
    expect(statuses).toEqual(['working', 'idle']);

    // The second turn replays the first one to the model.
    await send('Et maintenant ?');
    await services.runtime.idle(chef.id);
    const thirdCall = model.doStreamCalls[2];
    expect(JSON.stringify(thirdCall?.prompt)).toContain('Terminé, tout va bien.');
    expect(JSON.stringify(thirdCall?.prompt)).toContain('echo bonjour');
  });

  it('writes deliverables into the workspace', async () => {
    const model = scripted([
      toolTurn('write_file', { path: '/workspace/outputs/rapport.md', content: '# Rapport\n' }),
      textTurn('Rapport écrit.'),
    ]);
    const { send, services, chef, events, testApp } = await start(model);
    await send('Écris le rapport');
    await services.runtime.idle(chef.id);
    const file = path.join(
      testApp.workspacesDir,
      chef.workspaceId as string,
      'outputs',
      'rapport.md',
    );
    expect(await readFile(file, 'utf8')).toBe('# Rapport\n');
    expect(events).toContainEqual({
      type: 'workspace.changed',
      workspaceId: chef.workspaceId,
      paths: ['outputs'],
    });
  });

  it('shows screenshots to the model as images at the next step, without storing them', async () => {
    const model = scripted([toolTurn('screenshot', {}), textTurn('Je vois le bureau.')]);
    const { send, conversation, services, chef } = await start(model);
    await send('Regarde ton écran');
    await services.runtime.idle(chef.id);

    const nextStep = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(nextStep).toContain('image/png');
    expect(nextStep).toContain('iVBOR'); // the PNG itself, as an image part

    const [, answer] = await conversation();
    const shot = answer?.parts[0];
    expect(shot).toMatchObject({ type: 'tool', toolName: 'screenshot', state: 'done' });
    expect(shot?.type === 'tool' && shot.image?.path).toMatch(/^bots\/chef\/captures\/.+\.png$/);

    const [stored] = await services.db
      .select({ transcript: messages.modelMessages })
      .from(messages)
      .where(eq(messages.id, answer?.id as string));
    expect(JSON.stringify(stored?.transcript)).not.toContain('iVBOR');
  });

  it('refuses file tools outside /workspace and reports tool errors', async () => {
    const model = scripted([
      toolTurn('read_file', { path: '/etc/passwd' }),
      textTurn('Je ne peux pas.'),
    ]);
    const { send, conversation, services, chef } = await start(model);
    await send('Lis /etc/passwd');
    await services.runtime.idle(chef.id);
    const [, answer] = await conversation();
    expect(answer?.parts[0]).toMatchObject({ type: 'tool', toolName: 'read_file', state: 'error' });
    expect(answer?.status).toBe('done');
  });

  it('can be stopped mid-answer', async () => {
    const model = scripted([textTurn('un deux trois quatre cinq six sept huit neuf dix')], 80);
    const { send, conversation, services, chef, app, token } = await start(model);
    await send('Compte');
    await vi.waitFor(async () => {
      expect((await conversation()).at(-1)?.status).toBe('streaming');
    });
    const stop = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/stop`,
      headers: bearer(token),
    });
    expect(stop.json()).toEqual({ stopped: true });
    await services.runtime.idle(chef.id);
    const answer = (await conversation()).at(-1);
    expect(answer?.status).toBe('stopped');
    expect((await services.bots.row(chef.id)).status).toBe('idle');
  });

  it('pages through the conversation', async () => {
    const model = scripted([textTurn('ok')]);
    const { send, services, chef, app, token } = await start(model);
    for (const text of ['un', 'deux', 'trois']) {
      await send(text);
      await services.runtime.idle(chef.id);
    }
    const first = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${chef.id}/messages?limit=4`,
        headers: bearer(token),
      })
    ).json();
    expect(first.items.map((m: Message) => m.role)).toEqual(
      ['assistant', 'user', 'assistant', 'user', 'assistant'].slice(1),
    );
    expect(first.nextCursor).toBeTruthy();
    const older = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/bots/${chef.id}/messages?limit=4&before=${encodeURIComponent(first.nextCursor)}`,
        headers: bearer(token),
      })
    ).json();
    expect(older.items).toHaveLength(2);
    expect(older.nextCursor).toBeNull();
  });
});

describe('language', () => {
  it('lets the owner pick the language bots answer in', async () => {
    const model = scripted([textTurn('Hi!')]);
    const { app, token, send, services, chef } = await start(model);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: bearer(token),
      payload: { locale: 'en' },
    });
    expect(res.json().owner.locale).toBe('en');
    await send('Hello');
    await services.runtime.idle(chef.id);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain('en anglais (English)');
  });
});
