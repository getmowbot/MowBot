import type { Bot, BotActivity, Message, ServerEvent, Task } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_TEXT_MAX, activityInput } from '../src/bots/activity';
import { cleanFocus, FOCUS_MAX } from '../src/bots/focus';
import { ACTIVITY_PUBLISH_MS } from '../src/bots/service';
import { tasks } from '../src/db/schema';
import { MASK } from '../src/vault/secrets';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(model?: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, model ? () => model : undefined);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) => app.inject({ method, url, headers: auth, payload });
  const chef: Bot = (await inject('GET', '/api/v1/bots')).json().items[0];
  const events: ServerEvent[] = [];
  services.events.subscribe((event) => events.push(event));
  const send = (text: string) => inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
  const bot = async (): Promise<Bot> => (await inject('GET', `/api/v1/bots/${chef.id}`)).json();
  return { inject, chef, events, send, bot, services, runtime };
}

/** What the bot.updated events said the bot worked on, in order. */
const focuses = (events: ServerEvent[], botId: string) =>
  events.flatMap((e) => (e.type === 'bot.updated' && e.bot.id === botId ? [e.bot.focus] : []));

/** What the bot.updated events said the bot was doing, in order. */
const told = (events: ServerEvent[], botId: string) =>
  events.flatMap((e) => (e.type === 'bot.updated' && e.bot.id === botId ? [e.bot.activity] : []));

/** A shell command that waits until the test lets it finish. */
function hold() {
  let release = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, ACTIVITY_PUBLISH_MS + 150));

describe('what of a tool call the apps see', () => {
  it('keeps the short fields an action is worded with', () => {
    expect(
      activityInput('bash', {
        intent: 'Lance les tests',
        command: 'cd /app && npm test',
        timeout_seconds: 60,
      }),
    ).toEqual({ intent: 'Lance les tests', command: 'cd /app && npm test' });
    expect(
      activityInput('send_message', {
        to: 'Sacha',
        text: 'Voici la playlist complète, morceau par morceau…',
        summary: 'La playlist est prête',
      }),
    ).toEqual({ to: 'Sacha', summary: 'La playlist est prête' });
    expect(activityInput('computer', { action: 'click', x: 10, y: 20, intent: 'Valide' })).toEqual({
      action: 'click',
      x: 10,
      y: 20,
      intent: 'Valide',
    });
  });

  it('never passes on contents or secrets', () => {
    expect(
      activityInput('write_file', { path: '/workspace/notes.md', content: 'TOP SECRET' }),
    ).toEqual({ path: '/workspace/notes.md' });
    expect(
      activityInput('local_edit', { path: 'src/app.ts', old_text: 'a', new_text: 'TOP SECRET' }),
    ).toEqual({ path: 'src/app.ts' });
    expect(
      activityInput('mcp_add', {
        name: 'GitHub',
        command: 'npx -y @modelcontextprotocol/server-github',
        env: { GITHUB_TOKEN: 'ghp_secret' },
        headers: { Authorization: 'Bearer secret' },
      }),
    ).toEqual({ name: 'GitHub', command: 'npx -y @modelcontextprotocol/server-github' });
    expect(
      activityInput('vault_save', {
        kind: 'login',
        service: 'BadNet',
        account: 'joris@example.com',
        username: 'joris',
        password: 'hunter2',
        totp: 'GEZDGNBVGY3TQOJQ',
        value: 'sk-secret',
      }),
    ).toEqual({ kind: 'login', service: 'BadNet' });
    expect(
      activityInput('mcp_call', {
        server: 'github',
        tool: 'create_issue',
        arguments: { token: 'secret' },
      }),
    ).toEqual({ server: 'github', tool: 'create_issue' });
    expect(activityInput('ask_bot', { to: 'Nova', question: 'Ton code ?' })).toEqual({
      to: 'Nova',
    });
    // An MCP server's own tools follow schemas the hub does not know: nothing of them goes out.
    expect(activityInput('mcp__github__create_issue', { title: 'Bug', key: 'sk-live' })).toEqual(
      {},
    );
  });

  it('cuts long strings and keeps no credentials of an address', () => {
    const command = activityInput('bash', { command: `echo ${'a'.repeat(500)}` }).command;
    expect(typeof command === 'string' && command.length).toBe(ACTIVITY_TEXT_MAX);
    expect(String(command).endsWith('…')).toBe(true);
    expect(
      activityInput('browser_open', { url: 'https://joris:pw@example.com/a/b?token=abc#top' }),
    ).toEqual({ url: 'https://example.com/a/b' });
    expect(
      activityInput('browser_open', { url: 'https://www.google.com/search?q=mow+bot&ei=xyz' }),
    ).toEqual({ url: 'https://www.google.com/search?q=mow%20bot' });
    expect(activityInput('computer', { action: 'click', x: Number.NaN, y: [1] })).toEqual({
      action: 'click',
    });
    expect(activityInput('bash', 'echo')).toEqual({});
    expect(activityInput('bash', null)).toEqual({});
  });
});

describe('what a bot is doing', () => {
  it('is the tool call it runs, and nothing once the call ends', async () => {
    const model = scripted([
      toolTurn('bash', {
        intent: 'Lance les tests',
        command: 'cd /app && npm test',
        timeout_seconds: 60,
      }),
      textTurn('Les tests passent.'),
    ]);
    const { send, chef, events, bot, services, runtime } = await start(model);
    const tests = hold();
    runtime.shell = async (script) => {
      if (!script.includes('npm test')) return undefined;
      await tests.done;
      return { stdout: 'ok' };
    };
    const running: BotActivity = {
      toolName: 'bash',
      input: { intent: 'Lance les tests', command: 'cd /app && npm test' },
    };

    await send('Lance les tests');
    await vi.waitFor(async () => expect((await bot()).activity).toEqual(running), {
      timeout: 10_000,
    });
    expect((await bot()).status).toBe('working');
    // The apps hear it too, once things settle.
    await vi.waitFor(() => expect(told(events, chef.id)).toContainEqual(running));

    tests.release();
    await services.runtime.idle(chef.id);
    expect(await bot()).toMatchObject({ status: 'idle', activity: null });
    await settled();
    expect(told(events, chef.id).at(-1)).toBeNull();
  });

  it('is nothing as soon as the bot is stopped, even if the call is still ending', async () => {
    const model = scripted([toolTurn('bash', { command: 'npm run build' }), textTurn('Fini.')]);
    const { send, chef, bot, services, runtime, inject } = await start(model);
    const build = hold();
    runtime.shell = async (script) => {
      if (!script.includes('npm run build')) return undefined;
      await build.done;
      return { stdout: 'built' };
    };

    await send('Construis le projet');
    await vi.waitFor(async () => expect((await bot()).activity?.toolName).toBe('bash'), {
      timeout: 10_000,
    });
    await inject('POST', `/api/v1/bots/${chef.id}/stop`);
    await vi.waitFor(async () => expect((await bot()).status).toBe('idle'));
    expect((await bot()).activity).toBeNull();

    build.release();
    await services.runtime.idle(chef.id);
    expect((await bot()).activity).toBeNull();
  });

  it('masks the vault’s secrets in what the apps see', async () => {
    const secret = 'hunter2-very-secret';
    const model = scripted([
      toolTurn('bash', { command: `login --user joris --password ${secret}` }),
      textTurn('Connecté.'),
    ]);
    const { send, chef, events, bot, services, runtime, inject } = await start(model);
    const created = await inject('POST', '/api/v1/vault/items', {
      kind: 'login',
      service: 'BadNet',
      username: 'joris',
      password: secret,
    });
    expect(created.statusCode).toBe(201);
    const login = hold();
    runtime.shell = async (script) => {
      if (!script.includes('login --user')) return undefined;
      await login.done;
      return { stdout: 'ok' };
    };

    await send('Connecte-toi');
    await vi.waitFor(async () => expect((await bot()).activity?.toolName).toBe('bash'), {
      timeout: 10_000,
    });
    expect((await bot()).activity?.input.command).toBe(`login --user joris --password ${MASK}`);
    await settled();
    login.release();
    await services.runtime.idle(chef.id);
    expect(told(events, chef.id).length).toBeGreaterThan(0);
    expect(JSON.stringify(told(events, chef.id))).not.toContain(secret);
  });

  it('goes out once for a burst of changes, and not at all when nothing changed', async () => {
    const { chef, events, services } = await start();
    const { activity } = services.bots;
    const readB: BotActivity = { toolName: 'read_file', input: { path: 'b.md' } };
    const tests: BotActivity = { toolName: 'bash', input: { command: 'npm test' } };

    activity.start(chef.id, 'a', { toolName: 'read_file', input: { path: 'a.md' } });
    activity.end(chef.id, 'a');
    activity.start(chef.id, 'b', readB);
    activity.start(chef.id, 'c', tests);
    expect(told(events, chef.id)).toEqual([]);
    await settled();
    expect(told(events, chef.id)).toEqual([tests]);

    // The last call started ends: the bot is back to the one still running.
    activity.end(chef.id, 'c');
    await settled();
    expect(told(events, chef.id)).toEqual([tests, readB]);

    // A call that starts and ends between two events changes nothing the apps know.
    activity.start(chef.id, 'd', tests);
    activity.end(chef.id, 'd');
    await settled();
    expect(told(events, chef.id)).toEqual([tests, readB]);

    // A change of the bot itself goes out at once, with what it is doing.
    await services.bots.update(chef.id, { mission: 'Coordonner' });
    expect(told(events, chef.id)).toEqual([tests, readB, readB]);
    activity.clear(chef.id);
    await settled();
    expect(told(events, chef.id)).toEqual([tests, readB, readB, null]);
  });
});

describe('what a bot works on', () => {
  it('keeps a sentence, on one line and short', () => {
    expect(cleanFocus('  Je développe\n  la page   d’accueil ')).toBe(
      'Je développe la page d’accueil',
    );
    expect(cleanFocus('   ')).toBeNull();
    expect(cleanFocus(null)).toBeNull();
    const long = cleanFocus('Je '.repeat(100)) as string;
    expect(long.length).toBeLessThanOrEqual(FOCUS_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is the sentence the bot sets, shown to the apps and to the other bots, until it clears it', async () => {
    const model = scripted([
      toolTurn('set_focus', { text: '  Je développe la page   d’accueil ' }),
      toolTurn('list_bots', {}, 'call-2'),
      textTurn('Je m’y mets.'),
      toolTurn('set_focus', { text: '' }, 'call-3'),
      textTurn('C’est fini.'),
    ]);
    const { send, chef, events, bot, services, inject } = await start(model);

    await send('Fais la page d’accueil');
    await services.runtime.idle(chef.id);
    expect((await bot()).focus).toBe('Je développe la page d’accueil');
    expect(focuses(events, chef.id)).toContain('Je développe la page d’accueil');
    const conversation: Message[] = (await inject('GET', `/api/v1/bots/${chef.id}/messages`)).json()
      .items;
    const directory = conversation
      .at(-1)
      ?.parts.find((p) => p.type === 'tool' && p.toolName === 'list_bots');
    expect(directory?.type === 'tool' && directory.output).toContain(
      '« Je développe la page d’accueil »',
    );

    await send('Tu as fini ?');
    await services.runtime.idle(chef.id);
    expect((await bot()).focus).toBeNull();
  });

  it('is the task the bot is doing when it said nothing, its own words first', async () => {
    const { chef, events, bot, services, inject } = await start();
    const task: Task = (
      await inject('POST', '/api/v1/tasks', { assigneeBotId: chef.id, title: 'Préparer la démo' })
    ).json();
    await services.runtime.settle();
    expect((await bot()).focus).toBeNull();

    await inject('PATCH', `/api/v1/tasks/${task.id}`, { status: 'doing' });
    await services.runtime.settle();
    expect((await bot()).focus).toBe('Préparer la démo');
    await settled();
    expect(focuses(events, chef.id).at(-1)).toBe('Préparer la démo');

    await services.bots.update(chef.id, { focus: 'Je relis le plan de la démo' });
    expect((await bot()).focus).toBe('Je relis le plan de la démo');
    await services.bots.update(chef.id, { focus: null });
    expect((await bot()).focus).toBe('Préparer la démo');

    await inject('PATCH', `/api/v1/tasks/${task.id}`, { status: 'done', result: 'Prête' });
    await services.runtime.settle();
    expect((await bot()).focus).toBeNull();
    await settled();
    expect(focuses(events, chef.id).at(-1)).toBeNull();
  });

  it('knows the tasks under way when the hub starts', async () => {
    const { chef, bot, services } = await start();
    await services.db
      .insert(tasks)
      .values({ title: 'Migrer la base', status: 'doing', assigneeBotId: chef.id });
    await services.bots.watchTasks();
    expect((await bot()).focus).toBe('Migrer la base');
  });

  it('is forgotten when the conversation starts over', async () => {
    const { chef, bot, services, inject } = await start();
    await services.bots.update(chef.id, { focus: 'Je range le dossier' });
    expect((await inject('DELETE', `/api/v1/bots/${chef.id}/messages`)).statusCode).toBe(204);
    expect((await bot()).focus).toBeNull();
  });
});
