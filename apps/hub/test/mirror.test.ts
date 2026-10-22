import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  Bot,
  Connector,
  ConnectorCreated,
  ConnectorPicked,
  Message,
  MessagePart,
  Notification,
  Project,
} from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config';
import { FakeConnector } from './fixtures/fake-connector';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, type Turn, textTurn, toolTurn } from './models';

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
  FakeConnector.version = '0.0.0-test';
  FakeConnector.maxFile = 20 * 1024 * 1024;
  FakeConnector.picked = null;
});

const until = async (check: () => Promise<boolean> | boolean, what = 'condition') => {
  for (let i = 0; i < 250; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const tools = (message: Message | undefined) =>
  (message?.parts ?? []).filter(
    (p): p is Extract<MessagePart, { type: 'tool' }> => p.type === 'tool',
  );

/**
 * A hub, the user's folder `site` shared by a desktop app of `version`, and the Chef working in
 * it: its mirror is in the Chef's workspace, `projects/site`.
 */
async function setup(options: {
  version: string;
  turns?: Turn[];
  config?: Partial<Config>;
  files?: Record<string, string | Buffer>;
  active?: boolean;
}) {
  const model = scripted(options.turns ?? [textTurn('Ok.')]);
  t = await createTestApp(options.config ?? {}, undefined, () => model);
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
  const workspaceId = chef.workspaceId as string;

  const folder = await mkdtemp(path.join(tmpdir(), 'mowbot-mirror-'));
  folders.push(folder);
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), content);
  }
  const created = await inject<ConnectorCreated>('POST', '/api/v1/connectors', { name: 'PC' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as { port: number };
  const url = `ws://127.0.0.1:${port}/api/v1/connectors/ws`;
  const connect = async (version = options.version) => {
    connector?.close();
    FakeConnector.version = version;
    connector = await FakeConnector.connect(
      url,
      created.body.token,
      [{ key: 'k', name: 'Site', path: '/home/joris/site' }],
      { k: folder },
    );
    await until(async () => {
      const [computer] = (await inject<{ items: Connector[] }>('GET', '/api/v1/connectors')).body
        .items;
      return computer?.online === true && computer.version === version;
    }, 'the computer');
    return connector;
  };
  const project = async () =>
    (await inject<{ items: Project[] }>('GET', '/api/v1/projects')).body.items[0];
  await connect();
  const projectId = (await project())?.id as string;
  if (options.active !== false) {
    expect((await inject('PUT', `/api/v1/bots/${chef.id}/project`, { projectId })).status).toBe(
      200,
    );
  }
  const mirror = () => services.mirrors.mirrorIn(projectId, workspaceId);
  const ws = (rel = '') => path.join(services.files.dirOf(workspaceId), 'projects', 'site', rel);
  const theirs = (rel: string) => path.join(folder, rel);
  /** A bot writes in the mirror (as write_file does: the workspace changed). */
  const botWrites = async (rel: string, content: string | Buffer) => {
    await services.files.writeFile(workspaceId, `projects/site/${rel}`, content);
    services.events.publish({ type: 'workspace.changed', workspaceId, paths: ['projects/site'] });
  };
  const botDeletes = async (rel: string) => {
    await rm(ws(rel));
    services.events.publish({ type: 'workspace.changed', workspaceId, paths: [''] });
  };
  /** The next reconcile, done. */
  const synced = async () => {
    const row = mirror();
    if (!row) throw new Error('No mirror');
    return services.mirrors.syncNow(row.id);
  };
  const say = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
    const items = (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`))
      .body.items;
    return { tools: tools(items.at(-1)), items };
  };
  if (options.active !== false) {
    await until(() => mirror()?.syncedAt != null || mirror()?.status === 'too_big', 'first copy');
  }
  return {
    app,
    services,
    model,
    inject,
    chef,
    workspaceId,
    folder,
    projectId,
    created,
    connect,
    project,
    mirror,
    ws,
    theirs,
    botWrites,
    botDeletes,
    synced,
    say,
  };
}

describe('a project mirrored in the workspace', () => {
  it('is copied once, then follows each side within seconds, deletions included', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const s = await setup({
      version: '0.2.5',
      files: {
        '.gitignore': 'dist/\n*.log\n',
        'README.md': '# Site\n',
        'src/app.js': 'console.log("Ancien titre")\n',
        'public/logo.png': png,
        'node_modules/lib/index.js': 'module.exports = 1\n',
        'dist/bundle.js': 'built\n',
        'debug.log': 'oops\n',
        '.git/HEAD': 'ref: refs/heads/main\n',
      },
    });

    // The first copy: what git would keep, never .git, dependencies or what .gitignore leaves out.
    expect(await readFile(s.ws('src/app.js'), 'utf8')).toContain('Ancien titre');
    expect(await readFile(s.ws('public/logo.png'))).toEqual(png);
    for (const rel of ['node_modules', 'dist', 'debug.log', '.git']) {
      expect(await exists(s.ws(rel))).toBe(false);
    }
    const shown = (await s.project())?.mirrors;
    expect(shown).toEqual([
      expect.objectContaining({
        workspaceId: s.workspaceId,
        folder: 'projects/site',
        status: 'synced',
        pending: 0,
        conflicts: [],
      }),
    ]);
    expect((await s.project())?.mirror).toBe(true);
    // The app watches the mirrored folder.
    await until(() => connector?.watched?.includes('k') === true, 'watch');

    // A bot edits, adds (text, a picture, ignored files) and deletes: their folder follows.
    await s.botWrites('src/app.js', 'console.log("Nouveau titre")\n');
    await s.botWrites('src/new.js', 'export const x = 1\n');
    await s.botWrites('public/hero.png', png);
    await s.botWrites('dist/out.js', 'built by the bot\n');
    await s.botWrites('node_modules/dep/index.js', 'dep\n');
    await s.botDeletes('README.md');
    await until(
      async () =>
        (await readFile(s.theirs('src/app.js'), 'utf8').catch(() => '')).includes(
          'Nouveau titre',
        ) && !(await exists(s.theirs('README.md'))),
      'the bot’s work on the computer',
    );
    expect(await readFile(s.theirs('src/new.js'), 'utf8')).toBe('export const x = 1\n');
    expect(await readFile(s.theirs('public/hero.png'))).toEqual(png);
    expect(await readFile(s.theirs('dist/bundle.js'), 'utf8')).toBe('built\n');
    expect(await exists(s.theirs('dist/out.js'))).toBe(false);
    expect(await exists(s.theirs('node_modules/dep'))).toBe(false);
    const puts = connector?.requests.filter((r) => r.op === 'put') ?? [];
    expect(puts.length).toBeGreaterThan(0);
    // Every write says what it expects to find there.
    for (const put of puts) {
      for (const file of put.args.files as { expect?: unknown }[]) {
        expect(file).toHaveProperty('expect');
      }
    }
    expect(connector?.requests.some((r) => r.op === 'delete')).toBe(true);

    // The user edits and deletes; the app tells the hub; the mirror follows.
    await writeFile(s.theirs('src/app.js'), 'console.log("Titre de Joris")\n');
    await rm(s.theirs('public/logo.png'));
    connector?.changed('k', ['src/app.js', 'public/logo.png']);
    await until(
      async () =>
        (await readFile(s.ws('src/app.js'), 'utf8')).includes('Titre de Joris') &&
        !(await exists(s.ws('public/logo.png'))),
      'the user’s change in the mirror',
    );
    // Only what changed was looked at.
    const scoped = connector?.requests.filter((r) => r.op === 'manifest' && r.args.paths);
    expect(scoped?.at(-1)?.args.paths).toEqual(['src/app.js', 'public/logo.png']);
    // The files land before the run saves where it stands.
    await until(() => s.mirror()?.status === 'synced', 'synced');
    expect(s.mirror()?.pending).toBe(0);
  });

  it('keeps the bots working while the computer is away, and catches up when it is back', async () => {
    const s = await setup({
      version: '0.2.5',
      files: { 'notes.md': '# Notes\n', 'todo.txt': 'pain\n', 'old.txt': 'x\n' },
    });
    connector?.close();
    await until(async () => (await s.project())?.online === false, 'offline');

    // Offline: the bot changes, adds and deletes in the mirror; the user edits another file.
    await s.botWrites('todo.txt', 'pain et lait\n');
    await s.botWrites('src/page.astro', '<h1>Hi</h1>\n');
    await s.botDeletes('old.txt');
    await writeFile(s.theirs('notes.md'), '# Notes de Joris\n');
    await until(() => s.mirror()?.status === 'pending' && s.mirror()?.pending === 3, 'pending');
    expect((await s.project())?.mirrors[0]).toMatchObject({ status: 'pending', pending: 3 });

    // Back: everything is reconciled without a bot doing anything.
    await s.connect();
    await until(async () => s.mirror()?.status === 'synced', 'synced again');
    expect(await readFile(s.theirs('todo.txt'), 'utf8')).toBe('pain et lait\n');
    expect(await readFile(s.theirs('src/page.astro'), 'utf8')).toBe('<h1>Hi</h1>\n');
    expect(await exists(s.theirs('old.txt'))).toBe(false);
    expect(await readFile(s.ws('notes.md'), 'utf8')).toBe('# Notes de Joris\n');
    expect(s.mirror()?.pending).toBe(0);
  });

  it('keeps both versions of a file changed on both sides, and tells the user and the bots', async () => {
    const s = await setup({
      version: '0.2.5',
      files: { 'src/app.js': 'v1\n', 'other.js': 'o1\n' },
    });
    connector?.close();
    await until(async () => (await s.project())?.online === false, 'offline');
    await s.botWrites('src/app.js', 'version du bot\n');
    // Deleted by the user, changed by the bot: the change wins.
    await s.botWrites('other.js', 'o2 du bot\n');
    await writeFile(s.theirs('src/app.js'), 'version de Joris\n');
    await rm(s.theirs('other.js'));

    await s.connect();
    await until(() => (s.mirror()?.conflicts.length ?? 0) > 0, 'the conflict');
    await until(() => s.mirror()?.status === 'synced', 'synced');
    // The user's version stays in place, and is the mirror's now.
    expect(await readFile(s.theirs('src/app.js'), 'utf8')).toBe('version de Joris\n');
    expect(await readFile(s.ws('src/app.js'), 'utf8')).toBe('version de Joris\n');
    expect(await readFile(s.theirs('other.js'), 'utf8')).toBe('o2 du bot\n');
    // The bots' version is kept aside, outside the mirror.
    const [conflict] = s.mirror()?.conflicts ?? [];
    expect(conflict?.path).toBe('src/app.js');
    expect(conflict?.copy).toMatch(
      /^projects\/_conflicts\/site\/\d{4}-\d{2}-\d{2}-\d{6}\/src\/app\.js$/,
    );
    const copy = path.join(
      s.services.files.dirOf(s.workspaceId),
      ...String(conflict?.copy).split('/'),
    );
    expect(await readFile(copy, 'utf8')).toBe('version du bot\n');
    // Nothing of it in the user's folder.
    expect(await readdir(s.folder)).toEqual(expect.not.arrayContaining(['_conflicts']));

    // The user is notified; the bot reads a note in its conversation.
    const notes = (await s.inject<{ items: Notification[] }>('GET', '/api/v1/notifications')).body
      .items;
    expect(notes.find((n) => n.title.includes('conflit'))?.body).toContain('src/app.js');
    const messages = (
      await s.inject<{ items: Message[] }>('GET', `/api/v1/bots/${s.chef.id}/messages`)
    ).body.items;
    const note = messages.at(-1);
    expect(note?.parts[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(note?.parts)).toContain('Un conflit dans Site');

    // Dismissed: the list empties, the bots' copy goes to the trash.
    const dismissed = await s.inject<Project>(
      'POST',
      `/api/v1/projects/${s.projectId}/conflicts/dismiss`,
      { workspaceId: s.workspaceId },
    );
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.mirrors[0]?.conflicts).toEqual([]);
    expect(await exists(copy)).toBe(false);
  });

  it('puts back files deleted all at once in the mirror instead of deleting them there', async () => {
    const files: Record<string, string> = { 'README.md': '# Site\n' };
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = `export const n = ${i};\n`;
    const s = await setup({ version: '0.2.5', files });
    await rm(s.ws('src'), { recursive: true });
    const report = await s.synced();
    expect(report?.restored).toBe(30);
    for (let i = 0; i < 30; i++) expect(await exists(s.theirs(`src/f${i}.ts`))).toBe(true);
    expect(await exists(s.ws('src/f7.ts'))).toBe(true);
    // A whole mirror gone is copied again, nothing deleted on their side.
    await rm(s.ws(), { recursive: true });
    await s.synced();
    expect(await exists(s.ws('src/f7.ts'))).toBe(true);
    expect(await exists(s.theirs('src/f7.ts'))).toBe(true);
  });

  it('copies a mirror deleted whole again, even when the computer was away meanwhile', async () => {
    const s = await setup({ version: '0.2.5', files: { 'a.txt': 'a\n', 'b/c.txt': 'c\n' } });
    connector?.close();
    await until(async () => (await s.project())?.online === false, 'offline');
    await rm(s.ws(), { recursive: true });
    await s.synced();
    await s.connect();
    await until(async () => exists(s.ws('b/c.txt')), 'copied again');
    expect(await readFile(s.theirs('a.txt'), 'utf8')).toBe('a\n');
    expect(await readFile(s.theirs('b/c.txt'), 'utf8')).toBe('c\n');
    expect(connector?.requests.some((r) => r.op === 'delete')).toBe(false);
  });

  it('stops at the size limit with a clear message, and can be turned off', async () => {
    const s = await setup({
      version: '0.2.5',
      config: { mirror: { maxBytes: 1024, maxFiles: 100 } },
      files: { 'big.txt': 'x'.repeat(4096), 'small.txt': 'ok\n' },
      turns: [toolTurn('local_read', { path: 'small.txt' }, 'r1'), textTurn('Lu.')],
    });
    expect(s.mirror()).toMatchObject({ status: 'too_big' });
    expect(s.mirror()?.error).toContain('Projet trop gros pour un miroir');
    expect(await exists(s.ws('small.txt'))).toBe(false);

    // Too big: the bot works in the folder directly.
    const { tools: used } = await s.say('Lis small.txt');
    expect(used.map((p) => p.state)).toEqual(['done']);
    expect(String(used[0]?.output)).toContain('ok');

    // Turned off: no mirror any more, the folder goes to the trash.
    const off = await s.inject<Project>('PATCH', `/api/v1/projects/${s.projectId}`, {
      mirror: false,
    });
    expect(off.body).toMatchObject({ mirror: false, mirrors: [] });
    expect(s.mirror()).toBeNull();
    await until(() => connector?.watched?.length === 0, 'no more watch');
  });

  it('leaves files too big for the mirror alone on both sides', async () => {
    FakeConnector.maxFile = 1000;
    const s = await setup({
      version: '0.2.5',
      files: { 'video.mp4': 'v'.repeat(2000), 'a.txt': 'a\n' },
    });
    expect(await exists(s.ws('a.txt'))).toBe(true);
    expect(await exists(s.ws('video.mp4'))).toBe(false);
    await s.synced();
    // Not listed by the app, but not deleted there either.
    expect(await exists(s.theirs('video.mp4'))).toBe(true);
    expect(s.mirror()?.status).toBe('synced');
  });

  it('works with an older desktop app: full looks, text writes, and what it cannot do waits', async () => {
    const s = await setup({
      version: '0.2.3',
      files: { 'notes.md': '# Notes\n', 'old.txt': 'x\n', 'node_modules/x.js': 'x\n' },
    });
    expect(await readFile(s.ws('notes.md'), 'utf8')).toBe('# Notes\n');
    // Older apps do not skip dependencies themselves: the hub does.
    expect(await exists(s.ws('node_modules'))).toBe(false);
    expect(connector?.watched).toBeNull();

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9]);
    await s.botWrites('notes.md', '# Notes du bot\n');
    await s.botWrites('logo.png', png);
    await s.botDeletes('old.txt');
    const report = await s.synced();
    expect(report).toMatchObject({ status: 'pending', pending: 2, sent: 1 });
    expect(report?.error).toContain('doit être mise à jour');
    expect(await readFile(s.theirs('notes.md'), 'utf8')).toBe('# Notes du bot\n');
    expect(await exists(s.theirs('logo.png'))).toBe(false);
    expect(await exists(s.theirs('old.txt'))).toBe(true);
    expect(connector?.requests.some((r) => r.op === 'put' || r.op === 'delete')).toBe(false);

    // The user's edits are seen on the next full look (no watcher).
    await writeFile(s.theirs('notes.md'), '# Notes de Joris\n');
    await s.synced();
    expect(await readFile(s.ws('notes.md'), 'utf8')).toBe('# Notes de Joris\n');

    // Updated to 0.2.4: pictures go in base64 (deletions still wait for 0.2.5).
    await s.connect('0.2.4');
    await s.synced();
    expect(await readFile(s.theirs('logo.png'))).toEqual(png);
    await until(() => s.mirror()?.status === 'pending', 'pending on 0.2.4');
    expect(s.mirror()?.pending).toBe(1);
    // 0.2.5: the deletion goes too.
    await s.connect('0.2.5');
    await until(() => s.mirror()?.status === 'synced', 'synced on 0.2.5');
    expect(await exists(s.theirs('old.txt'))).toBe(false);
  });
});

describe('bots in a mirrored project', () => {
  it('are told where the mirror is, sync it, and run commands on the computer with it', async () => {
    const s = await setup({
      version: '0.2.5',
      files: { 'index.html': '<h1>Accueil</h1>\n' },
      turns: [
        toolTurn('local_sync', {}, 'c2'),
        toolTurn('local_exec', { command: 'npm test' }, 'c3'),
        textTurn('Fait.'),
      ],
    });
    await s.inject('PATCH', `/api/v1/projects/${s.projectId}`, { mode: 'auto' });
    await s.botWrites('index.html', '<h1>Nouvel accueil</h1>\n');
    const { tools: used } = await s.say('Mets à jour le site et lance les tests');
    const prompt = promptOf(s.model, 0);
    expect(prompt).toContain('Son miroir : /workspace/projects/site');
    expect(prompt).toContain('miroir /workspace/projects/site');
    const offered = (s.model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toEqual(
      expect.arrayContaining(['local_sync', 'local_exec', 'local_use_project', 'bash']),
    );
    // One way to work on its files: the mirror (no copy and push, no remote file tools).
    for (const gone of ['local_pull', 'local_push', 'local_read', 'local_edit']) {
      expect(offered).not.toContain(gone);
    }
    expect(used.map((p) => [p.toolName, p.state])).toEqual([
      ['local_sync', 'done'],
      ['local_exec', 'done'],
    ]);
    expect(String(used[0]?.output)).toContain('/workspace/projects/site synchronisé');
    expect(await readFile(s.theirs('index.html'), 'utf8')).toBe('<h1>Nouvel accueil</h1>\n');
    expect(connector?.requests.at(-1)?.op).not.toBe('exec');
    const exec = connector?.requests.findIndex((r) => r.op === 'exec') ?? -1;
    expect(exec).toBeGreaterThan(0);
  });

  it('are told to run things in the mirror while the computer is offline', async () => {
    const s = await setup({
      version: '0.2.5',
      files: { 'a.txt': 'a\n' },
      turns: [toolTurn('local_exec', { command: 'npm test' }, 'c1'), textTurn('Ok.')],
    });
    connector?.close();
    await until(async () => (await s.project())?.online === false, 'offline');
    const { tools: used } = await s.say('Lance les tests');
    expect(promptOf(s.model, 0)).toContain('continue dans le miroir');
    expect(used[0]?.state).toBe('error');
    expect(String(used[0]?.output)).toContain(
      'lance la commande sur ton PC, dans /workspace/projects/site',
    );
  });

  it('get a folder added from another device, as their active project', async () => {
    const s = await setup({ version: '0.2.5', active: false });
    const blog = await mkdtemp(path.join(tmpdir(), 'mowbot-blog-'));
    folders.push(blog);
    await writeFile(path.join(blog, 'post.md'), '# Premier billet\n');
    FakeConnector.picked = { key: 'k-blog', name: 'Blog', path: '/home/joris/blog', root: blog };
    const picked = await s.inject<ConnectorPicked>(
      'POST',
      `/api/v1/connectors/${s.created.body.connector.id}/pick`,
      { botId: s.chef.id },
    );
    expect(picked.status).toBe(200);
    expect(picked.body.project).toMatchObject({ name: 'Blog', key: 'k-blog' });
    const chef = (await s.inject<Bot>('GET', `/api/v1/bots/${s.chef.id}`)).body;
    expect(chef.projectId).toBe(picked.body.project?.id);
    const blogMirror = () =>
      s.services.mirrors.mirrorIn(picked.body.project?.id as string, s.workspaceId);
    await until(() => blogMirror()?.status === 'synced', 'blog mirrored');
    expect(blogMirror()?.folder).toBe('projects/blog');
    const copy = path.join(s.services.files.dirOf(s.workspaceId), 'projects', 'blog', 'post.md');
    expect(await readFile(copy, 'utf8')).toBe('# Premier billet\n');

    // Cancelled: nothing changes.
    FakeConnector.picked = null;
    const cancelled = await s.inject<ConnectorPicked>(
      'POST',
      `/api/v1/connectors/${s.created.body.connector.id}/pick`,
      {},
    );
    expect(cancelled.body.project).toBeNull();

    // An older app cannot open its picker for the hub.
    await s.connect('0.2.4');
    const old = await s.inject(
      'POST',
      `/api/v1/connectors/${s.created.body.connector.id}/pick`,
      {},
    );
    expect(old.status).toBe(409);
  });
});
