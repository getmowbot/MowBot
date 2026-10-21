import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Bot, ConnectorCreated, Message, MessagePart, Project } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeConnector } from './fixtures/fake-connector';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

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

const lastTools = (messages: Message[]) =>
  (messages.at(-1)?.parts ?? []).filter(
    (p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool',
  );

describe('a project copied to the bot’s PC', () => {
  it('comes back as a git branch, and a new copy keeps the bot’s changes', async () => {
    const model = scripted([
      toolTurn('local_pull', { project: 'Site' }, 'pull-1'),
      textTurn('Copié.'),
      toolTurn('local_push', { project: 'Site', message: 'Corrige le titre' }, 'push-1'),
      textTurn('Branche créée.'),
      toolTurn('local_pull', { project: 'Site' }, 'pull-2'),
      textTurn('Recopié.'),
    ]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    const workspaceId = chef.workspaceId as string;
    const say = async (text: string) => {
      await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
      await services.runtime.settle();
      return lastTools(
        (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items,
      );
    };

    // The user's project: a .gitignore, sources, and installed dependencies.
    folder = await mkdtemp(path.join(tmpdir(), 'mowbot-sync-'));
    await mkdir(path.join(folder, 'src'));
    await mkdir(path.join(folder, 'node_modules', 'lib'), { recursive: true });
    await writeFile(path.join(folder, '.gitignore'), 'dist/\n');
    await writeFile(path.join(folder, 'README.md'), '# Site\n');
    await writeFile(path.join(folder, 'src', 'app.js'), 'console.log("Ancien titre")\n');
    await writeFile(path.join(folder, 'node_modules', 'lib', 'index.js'), 'module.exports = 1\n');

    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'PC' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    connector = await FakeConnector.connect(
      `ws://127.0.0.1:${port}/api/v1/connectors/ws`,
      created.body.token,
      [{ key: 'k', name: 'Site', path: '/home/joris/site' }],
      { k: folder },
    );
    for (let i = 0; i < 100; i++) {
      const [project] = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items;
      if (project?.online) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const pulled = await say('Copie le site sur ton PC');
    expect(pulled[0]?.state).toBe('done');
    expect(String(pulled[0]?.output)).toContain('Copié dans /workspace/projects/site : 3 fichiers');
    const copy = (rel: string) =>
      services.files.readText(workspaceId, `projects/site/${rel}`).then((r) => r.text);
    expect(await copy('src/app.js')).toContain('Ancien titre');
    await expect(copy('node_modules/lib/index.js')).rejects.toThrow();

    // The bot works in its copy: one file changed, one added, one generated (ignored), one removed.
    await services.files.writeFile(
      workspaceId,
      'projects/site/src/app.js',
      'console.log("Nouveau titre")\n',
    );
    await services.files.writeFile(workspaceId, 'projects/site/src/new.js', 'export const x = 1\n');
    await services.files.writeFile(workspaceId, 'projects/site/dist/bundle.js', 'built\n');
    await services.files.writeFile(workspaceId, 'projects/site/node_modules/a/b.js', 'dep\n');
    await services.files.unlink(workspaceId, 'projects/site/README.md');

    const pushed = await say('Rapporte tes changements');
    expect(pushed[0]?.state).toBe('done');
    expect(String(pushed[0]?.output)).toContain('1 modifié, 1 ajouté, 1 supprimé');
    const branch = connector.requests.find((r) => r.op === 'branch');
    expect(branch?.args).toMatchObject({
      message: 'Corrige le titre',
      base: 'abc1234def5678',
      author: { name: 'Chef (MowBot)' },
      deletes: ['README.md'],
    });
    expect(String(branch?.args.name)).toMatch(/^mowbot\/chef-\d{8}-\d{4}$/);
    const sent = ((branch?.args.files ?? []) as { path: string; data: string }[]).map((f) => [
      f.path,
      Buffer.from(f.data, 'base64').toString(),
    ]);
    expect(sent.sort()).toEqual([
      ['src/app.js', 'console.log("Nouveau titre")\n'],
      ['src/new.js', 'export const x = 1\n'],
    ]);

    // The user changes the same file and adds one: the bot's version is kept, the new one comes.
    await writeFile(path.join(folder, 'src', 'app.js'), 'console.log("Titre du user")\n');
    await writeFile(path.join(folder, 'src', 'other.js'), 'export const y = 2\n');
    const again = await say('Recopie le site');
    expect(String(again[0]?.output)).toContain('Gardés tels que tu les as modifiés');
    expect(String(again[0]?.output)).toContain('src/app.js');
    expect(await copy('src/app.js')).toContain('Nouveau titre');
    expect(await copy('src/other.js')).toContain('y = 2');
  });

  it('writes the changes straight into a folder that is not a git repository', async () => {
    const model = scripted([
      toolTurn('local_push', { project: 'Notes', message: 'm' }, 'push-1'),
      toolTurn('local_pull', { project: 'Notes' }, 'pull-1'),
      textTurn('Copié.'),
      toolTurn('local_push', { project: 'Notes', message: 'm' }, 'push-2'),
      textTurn('Rapporté.'),
      toolTurn('local_push', { project: 'Notes', message: 'm' }, 'push-3'),
      textTurn('Rapporté.'),
    ]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    const workspaceId = chef.workspaceId as string;
    const say = async (text: string) => {
      await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
      await services.runtime.settle();
      return lastTools(
        (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items,
      );
    };
    folder = await mkdtemp(path.join(tmpdir(), 'mowbot-sync-'));
    const theirs = (rel: string) => readFile(path.join(folder as string, rel));
    await writeFile(path.join(folder, 'todo.txt'), 'acheter du pain\n');
    await writeFile(path.join(folder, 'notes.md'), '# Notes\n');
    await writeFile(path.join(folder, 'old.txt'), 'x\n');
    const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'PC' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };
    // An app from before binary writes, then one that has them.
    const connect = async (version: string) => {
      connector?.close();
      FakeConnector.version = version;
      connector = await FakeConnector.connect(
        `ws://127.0.0.1:${port}/api/v1/connectors/ws`,
        created.body.token,
        [{ key: 'k', name: 'Notes', path: '/home/joris/notes' }],
        { k: folder as string },
      );
      for (let i = 0; i < 100; i++) {
        const [project] = (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body
          .items;
        if (project?.online) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    FakeConnector.head = null;
    try {
      await connect('0.2.3');
      const first = await say('Copie les notes');
      expect(first.map((p) => p.state)).toEqual(['error', 'done']);
      expect(String(first[0]?.output)).toContain("fais d'abord local_pull");
      expect(String(first[1]?.output)).toContain('Pas de dépôt git');

      // The bot changes, adds (text and a picture) and removes; the user edits notes.md meanwhile.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
      await services.files.writeFile(workspaceId, 'projects/notes/todo.txt', 'pain et lait\n');
      await services.files.writeFile(workspaceId, 'projects/notes/notes.md', '# Notes du bot\n');
      await services.files.writeFile(workspaceId, 'projects/notes/src/page.astro', '<h1>Hi</h1>\n');
      await services.files.writeFile(workspaceId, 'projects/notes/public/logo.png', png);
      await services.files.unlink(workspaceId, 'projects/notes/old.txt');
      await writeFile(path.join(folder, 'notes.md'), '# Notes de Joris\n');

      const pushed = await say('Rapporte');
      expect(pushed[0]?.state).toBe('done');
      const said = String(pushed[0]?.output);
      expect(said).toContain('pas un dépôt git) : 1 modifié, 1 ajouté.');
      expect(said).toContain(
        "Laissés tels quels, l'utilisateur les a changés depuis ta copie : notes.md",
      );
      expect(said).toContain(
        'Pas copiés, fichiers binaires (son app MowBot desktop doit être mise à jour) : public/logo.png',
      );
      expect(said).toContain(
        'Supprimés dans ta copie mais pas chez lui (local_push ne supprime rien) : old.txt',
      );
      expect((await theirs('todo.txt')).toString()).toBe('pain et lait\n');
      expect((await theirs('src/page.astro')).toString()).toBe('<h1>Hi</h1>\n');
      expect((await theirs('notes.md')).toString()).toBe('# Notes de Joris\n');
      expect((await theirs('old.txt')).toString()).toBe('x\n');
      expect(connector?.requests.some((r) => r.op === 'branch')).toBe(false);

      // An up-to-date app takes the picture; what was written is not sent again.
      await connect('0.2.4');
      const again = await say('Rapporte encore');
      expect(String(again[0]?.output)).toContain('0 modifié, 1 ajouté.');
      expect(await theirs('public/logo.png')).toEqual(png);
      const writes = (connector?.requests ?? []).filter((r) => r.op === 'write');
      expect(writes.map((r) => r.args.path)).toEqual(['public/logo.png']);
      expect(writes[0]?.args.base64).toBe(true);
    } finally {
      FakeConnector.head = 'abc1234def5678';
      FakeConnector.version = '0.0.0-test';
    }
  });
});
