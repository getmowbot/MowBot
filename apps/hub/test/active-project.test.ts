import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Bot,
  ConnectorCreated,
  Message,
  MessagePart,
  Problem,
  Project,
  ServerEvent,
} from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeConnector } from './fixtures/fake-connector';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
let folders: string[] = [];
let connector: FakeConnector | undefined;

afterEach(async () => {
  connector?.close();
  connector = undefined;
  await t?.close();
  t = undefined;
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
  folders = [];
});

const until = async (check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out');
};

const tools = (message: Message | undefined) =>
  (message?.parts ?? []).filter(
    (p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool',
  );

const textOf = (message: Message | undefined) =>
  (message?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');

describe('the project a bot works in', () => {
  it('is picked in the conversation, told to the bot, and used by local_* by default', async () => {
    const model = scripted([
      // "Lis la page d'accueil": no project named.
      toolTurn('local_read', { path: 'index.html' }, 'call-1'),
      textTurn('Lu.'),
      // "Je bosse sur la compta": the bot switches by itself.
      toolTurn('local_use_project', { project: 'compta' }, 'call-2'),
      toolTurn('local_list', {}, 'call-3'),
      textTurn('C’est noté.'),
      // No project any more: it must name one.
      toolTurn('local_read', { path: 'index.html' }, 'call-4'),
      textTurn('Lequel ?'),
      // "@Compta".
      textTurn('Vu.'),
    ]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const events: ServerEvent[] = [];
    services.events.subscribe((event) => events.push(event));
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(
      method: 'GET' | 'POST' | 'PATCH' | 'PUT',
      url: string,
      payload?: unknown,
    ) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    expect(chef.projectId).toBeNull();
    const messages = async () =>
      (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
    const pick = (projectId: string | null) =>
      inject<Bot & Problem>('PUT', `/api/v1/bots/${chef.id}/project`, { projectId });

    const site = await mkdtemp(path.join(tmpdir(), 'mowbot-site-'));
    const compta = await mkdtemp(path.join(tmpdir(), 'mowbot-compta-'));
    folders = [site, compta];
    await writeFile(path.join(site, 'index.html'), '<h1>Accueil</h1>\n');
    await writeFile(path.join(compta, 'factures.csv'), 'date;montant\n');
    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'PC' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const shared = [
      { key: 'k-site', name: 'Site', path: '/home/joris/site' },
      { key: 'k-compta', name: 'Compta', path: '/home/joris/compta' },
    ];
    connector = await FakeConnector.connect(
      `ws://127.0.0.1:${port}/api/v1/connectors/ws`,
      created.body.token,
      shared,
      { 'k-site': site, 'k-compta': compta },
    );
    let projects: Project[] = [];
    await until(async () => {
      projects = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items;
      return projects.length === 2 && projects.every((p) => p.online);
    });
    const siteId = projects.find((p) => p.name === 'Site')?.id as string;
    const comptaId = projects.find((p) => p.name === 'Compta')?.id as string;

    // The user picks Site: every device hears it, the bot gets a silent note and does not answer.
    const picked = await pick(siteId);
    expect(picked.status).toBe(200);
    expect(picked.body.projectId).toBe(siteId);
    expect(events).toContainEqual({
      type: 'bot.updated',
      bot: expect.objectContaining({ id: chef.id, projectId: siteId }),
    });
    await services.runtime.settle();
    expect(model.doStreamCalls).toHaveLength(0);
    let items = await messages();
    expect(items.map((m) => [m.role, textOf(m)])).toEqual([['user', '📁 Projet actif : Site']]);

    // Changed again before the bot read it: the same note says the last choice.
    await pick(comptaId);
    await pick(siteId);
    // The same project again changes nothing.
    expect((await pick(siteId)).body.projectId).toBe(siteId);
    items = await messages();
    expect(items.map((m) => textOf(m))).toEqual(['📁 Projet actif : Site']);

    // The bot knows, and reads in Site without naming it.
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: "Lis la page d'accueil" });
    await services.runtime.settle();
    const prompt = promptOf(model, 0);
    expect(prompt).toContain('Projet actif : Site (PC-de-test, linux, en ligne)');
    expect(prompt).toContain("[L'utilisateur a choisi le projet actif : Site");
    let answer = (await messages()).at(-1);
    expect(tools(answer).map((p) => [p.toolName, p.state])).toEqual([['local_read', 'done']]);
    expect(String(tools(answer)[0]?.output)).toContain('<h1>Accueil</h1>');

    // Told "I work on the accounts now", the bot switches itself; devices follow.
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Je bosse sur la compta' });
    await services.runtime.settle();
    answer = (await messages()).at(-1);
    expect(tools(answer).map((p) => [p.toolName, p.state])).toEqual([
      ['local_use_project', 'done'],
      ['local_list', 'done'],
    ]);
    expect(String(tools(answer)[0]?.output)).toContain('Projet actif : Compta');
    expect(String(tools(answer)[1]?.output)).toContain('factures.csv');
    expect((await inject<Bot>('GET', `/api/v1/bots/${chef.id}`)).body.projectId).toBe(comptaId);
    expect(events).toContainEqual({
      type: 'bot.updated',
      bot: expect.objectContaining({ id: chef.id, projectId: comptaId }),
    });

    // No project: the note says so, and a local_* call without a project asks which one.
    expect((await pick(null)).body.projectId).toBeNull();
    expect(textOf((await messages()).at(-1))).toBe('📁 Aucun projet actif');
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Et le site ?' });
    await services.runtime.settle();
    expect(promptOf(model, 5)).toContain('Aucun projet actif : précise project');
    answer = (await messages()).at(-1);
    expect(tools(answer).map((p) => p.state)).toEqual(['error']);
    expect(String(tools(answer)[0]?.output)).toContain('Aucun projet actif : précise project');

    // A project written with @ is described to the bot.
    const sent = await inject<Message>('POST', `/api/v1/bots/${chef.id}/messages`, {
      text: 'Regarde @Compta',
      mentions: [{ kind: 'project', id: comptaId }],
    });
    expect(sent.body.mentions).toEqual([{ kind: 'project', id: comptaId, label: 'Compta' }]);
    await services.runtime.settle();
    expect(promptOf(model, 7)).toContain(
      '- @Compta : le projet Compta, dossier /home/joris/compta',
    );

    // Only a project the bot may use, and one that exists.
    await inject('PATCH', `/api/v1/projects/${siteId}`, {
      scope: { kind: 'bots', ids: ['00000000-0000-4000-8000-000000000000'] },
    });
    const refused = await pick(siteId);
    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:mowbot:problem:project_not_allowed');
    expect((await pick('00000000-0000-4000-8000-000000000001')).status).toBe(404);

    // Unshared from the desktop app: the bot has no project any more, and everyone hears it.
    await pick(comptaId);
    events.length = 0;
    connector.socket.send(JSON.stringify({ t: 'projects', projects: [shared[0]] }));
    await until(() =>
      events.some(
        (e) => e.type === 'bot.updated' && e.bot.id === chef.id && e.bot.projectId === null,
      ),
    );
    expect((await inject<Bot>('GET', `/api/v1/bots/${chef.id}`)).body.projectId).toBeNull();
  });

  it('tells the bot when the computer of its project is offline', async () => {
    const model = scripted([textTurn('Ok.')]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    const folder = await mkdtemp(path.join(tmpdir(), 'mowbot-site-'));
    folders = [folder];
    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'PC' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    connector = await FakeConnector.connect(
      `ws://127.0.0.1:${port}/api/v1/connectors/ws`,
      created.body.token,
      [{ key: 'k1', name: 'Site', path: '/home/joris/site' }],
      { k1: folder },
    );
    let project: Project | undefined;
    await until(async () => {
      project = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items[0];
      return project?.online === true;
    });
    connector.close();
    await until(async () => {
      project = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items[0];
      return project?.online === false;
    });

    // Offline computers can still be picked: the bot hears it cannot reach them yet.
    expect(
      (await inject<Bot>('PUT', `/api/v1/bots/${chef.id}/project`, { projectId: project?.id }))
        .status,
    ).toBe(200);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Salut' });
    await services.runtime.settle();
    const prompt = promptOf(model, 0);
    expect(prompt).toContain('Projet actif : Site (PC-de-test, linux, hors ligne)');
    expect(prompt).toContain("Pour l'instant, son ordinateur est hors ligne");
  });
});
