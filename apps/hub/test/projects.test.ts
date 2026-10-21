import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Bot,
  ConnectorCreated,
  Message,
  MessagePart,
  Project,
  Question,
} from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { FakeConnector } from './fixtures/fake-connector';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
let folder: string | undefined;
let connector: FakeConnector | undefined;

afterEach(async () => {
  connector?.close();
  connector = undefined;
  await t?.close();
  t = undefined;
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

const until = async (check: () => Promise<boolean>) => {
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

describe('projects on the user’s computer', () => {
  it('let bots read, edit and search freely, and run commands once the user agrees', async () => {
    const model = scripted([
      toolTurn('local_projects', {}, 'call-1'),
      toolTurn('local_search', { project: 'Site', pattern: 'titre' }, 'call-2'),
      toolTurn(
        'local_edit',
        {
          project: 'site',
          path: '/index.html',
          old_text: 'Ancien titre',
          new_text: 'Nouveau titre',
        },
        'call-3',
      ),
      toolTurn(
        'local_exec',
        { project: 'Site', command: 'npm test', intent: 'Lance les tests' },
        'call-4',
      ),
      textTurn('Je lance les tests dès que tu es d’accord.'),
      // After "Autoriser".
      toolTurn('local_exec', { project: 'Site', command: 'npm test' }, 'call-5'),
      textTurn('Les tests passent.'),
      // Asked again later: the approval was for one run.
      toolTurn('local_exec', { project: 'Site', command: 'npm test' }, 'call-6'),
      textTurn('Il me faut encore ton accord.'),
    ]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    folder = await mkdtemp(path.join(tmpdir(), 'mowbot-project-'));
    await writeFile(path.join(folder, 'index.html'), '<h1>Ancien titre</h1>\n<p>Accueil</p>\n');

    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', {
      name: 'PC de Joris',
    });
    expect(created.status).toBe(201);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    const url = `ws://127.0.0.1:${port}/api/v1/connectors/ws`;

    // A wrong token is turned away before the WebSocket opens.
    await expect(FakeConnector.connect(url, 'mbc_nope', [], {})).rejects.toThrow(/401/);

    connector = await FakeConnector.connect(
      url,
      created.body.token,
      [{ key: 'k-site', name: 'Site', path: 'C:\\Users\\Joris\\site' }],
      { 'k-site': folder },
    );
    let project: Project | undefined;
    await until(async () => {
      project = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items[0];
      return project?.online === true;
    });
    expect(project).toMatchObject({ name: 'Site', path: 'C:\\Users\\Joris\\site', mode: 'ask' });

    await inject('POST', `/api/v1/bots/${chef.id}/messages`, {
      text: 'Change le titre du site et lance les tests',
    });
    await services.runtime.settle();

    expect(promptOf(model, 0)).toContain("## Les projets de l'utilisateur");
    expect(promptOf(model, 0)).toContain(
      '- Site : C:\\\\Users\\\\Joris\\\\site (PC-de-test, linux)',
    );
    expect(await readFile(path.join(folder, 'index.html'), 'utf8')).toContain('Nouveau titre');
    let messages = (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`))
      .body.items;
    const first = tools(messages.at(-1));
    expect(first.map((p) => [p.toolName, p.state])).toEqual([
      ['local_projects', 'done'],
      ['local_search', 'done'],
      ['local_edit', 'done'],
      ['local_exec', 'error'],
    ]);
    expect(String(first[1]?.output)).toContain('index.html:1: <h1>Ancien titre</h1>');
    expect(String(first[3]?.output)).toContain("attend l'accord de l'utilisateur");
    // Nothing ran on the computer.
    expect(connector.requests.map((r) => r.op)).toEqual(['search', 'edit']);

    const [question] = (await inject<{ items: Question[] }>('GET', '/api/v1/questions')).body.items;
    expect(question?.question).toContain(
      'Chef veut lancer une commande dans « Site » sur PC-de-test',
    );
    expect(question?.question).toContain('npm test');
    expect(question?.options).toEqual(['Autoriser', 'Tout autoriser dans ce projet', 'Refuser']);

    await inject('POST', `/api/v1/questions/${question?.id}/answer`, { answer: 'Autoriser' });
    await services.runtime.settle();
    messages = (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body
      .items;
    const ran = tools(messages.at(-1));
    expect(ran.map((p) => p.state)).toEqual(['done']);
    expect(String(ran[0]?.output)).toContain('"stdout":"ran: npm test"');
    expect(connector.requests.at(-1)).toMatchObject({ op: 'exec', args: { command: 'npm test' } });

    // Once only: the next run asks again; "everything in this project" turns on auto mode.
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Relance-les' });
    await services.runtime.settle();
    const [again] = (await inject<{ items: Question[] }>('GET', '/api/v1/questions')).body.items;
    expect(again?.id).not.toBe(question?.id);
    await inject('POST', `/api/v1/questions/${again?.id}/answer`, {
      answer: 'Tout autoriser dans ce projet',
    });
    const [auto] = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items;
    expect(auto?.mode).toBe('auto');
  });

  it('keeps projects to the bots allowed, and forgets them with their computer', async () => {
    const model = scripted([textTurn('Ok.')]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
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
    folder = await mkdtemp(path.join(tmpdir(), 'mowbot-project-'));
    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'Mac' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    connector = await FakeConnector.connect(
      `ws://127.0.0.1:${port}/api/v1/connectors/ws`,
      created.body.token,
      [{ key: 'k1', name: 'Compta', path: '/Users/joris/compta' }],
      { k1: folder },
    );
    let project: Project | undefined;
    await until(async () => {
      project = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items[0];
      return project?.online === true;
    });

    // Only for another bot: the Chef does not see it.
    const patched = await inject<Project>('PATCH', `/api/v1/projects/${project?.id}`, {
      scope: { kind: 'bots', ids: ['00000000-0000-4000-8000-000000000000'] },
    });
    expect(patched.status).toBe(200);
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Salut' });
    await services.runtime.settle();
    expect(promptOf(model, 0)).not.toContain('Compta');
    expect(Object.keys(model.doStreamCalls[0]?.tools ?? {})).not.toContain('local_read');

    // Unlinking the computer closes its connection and removes its projects.
    const closed = new Promise<number>((resolve) => connector?.socket.once('close', resolve));
    expect((await inject('DELETE', `/api/v1/connectors/${created.body.connector.id}`)).status).toBe(
      204,
    );
    expect(await closed).toBe(4401);
    expect((await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items).toEqual([]);
    expect(connector.socket.readyState).not.toBe(WebSocket.OPEN);
  });
});
