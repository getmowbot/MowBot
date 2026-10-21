import type { Bot, FeedItem, Message, ServerEvent, Task, Team } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DEPTH } from '../src/agents/runtime';
import { FileLocks, ScreenLeases } from '../src/agents/shared-pc';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, scriptedBy, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A hub whose bots answer with the model registered under their name. */
async function start(models: Record<string, MockLanguageModelV4> = {}) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null, {
    askTimeoutMs: 5_000,
  });
  const { app, services } = t;
  const token = (await setupOwner(t.app)).accessToken;
  const auth = bearer(token);
  const get = async <T>(url: string): Promise<T> =>
    (await app.inject({ method: 'GET', url, headers: auth })).json();
  const chef = (await get<{ items: Bot[] }>('/api/v1/bots')).items[0] as Bot;
  const main = (await get<{ items: Team[] }>('/api/v1/teams')).items[0] as Team;
  const events: ServerEvent[] = [];
  services.events.subscribe((event) => events.push(event));
  const createBot = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth,
      payload: { role: 'Assistant', teamId: main.id, ...body },
    });
    if (res.statusCode !== 201) throw new Error(`createBot ${res.statusCode} ${res.body}`);
    return res.json() as Bot;
  };
  const conversation = (botId: string) =>
    get<{ items: Message[] }>(`/api/v1/bots/${botId}/messages`).then((r) => r.items);
  const say = async (botId: string, text: string) => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${botId}/messages`,
      headers: auth,
      payload: { text },
    });
    await services.runtime.settle();
  };
  return { app, services, auth, get, chef, main, events, createBot, conversation, say };
}

describe('organisation', () => {
  it('has the Chef lead the main team', async () => {
    const { main, chef } = await start();
    expect(main).toMatchObject({ isMain: true, leadBotId: chef.id });
  });

  it('creates teams with their own workspace and PC', async () => {
    const { app, auth, get, services, events } = await start();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: auth,
      payload: { name: 'Marketing', mission: 'Faire connaître le produit' },
    });
    expect(res.statusCode).toBe(201);
    const team: Team = res.json();
    expect(team).toMatchObject({ name: 'Marketing', isMain: false, leadBotId: null });
    const { items: pcs } = await get<{ items: { id: string; kind: string; teamId: string }[] }>(
      '/api/v1/computers',
    );
    expect(pcs.find((pc) => pc.id === team.computerId)).toMatchObject({
      kind: 'team',
      teamId: team.id,
    });
    const listing = await services.files.list(team.workspaceId, '');
    expect(listing.entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['outputs', 'shared']),
    );
    expect(events).toContainEqual({ type: 'team.updated', team });
  });

  it('puts bots on the team PC, on a dedicated PC, or solo', async () => {
    const { createBot, main, get, app, auth } = await start();
    const nova = await createBot({ name: 'Nova', lead: false });
    expect(nova).toMatchObject({ teamId: main.id, computerId: main.computerId });

    const atlas = await createBot({ name: 'Atlas', computer: 'dedicated' });
    const { items: pcs } = await get<{
      items: { id: string; kind: string; workspaceId: string }[];
    }>('/api/v1/computers');
    expect(pcs.find((pc) => pc.id === atlas.computerId)).toMatchObject({
      kind: 'dedicated',
      workspaceId: main.workspaceId,
    });

    const solo = await createBot({ name: 'Iris', teamId: null });
    expect(solo.teamId).toBeNull();
    expect(solo.workspaceId).not.toBe(main.workspaceId);
    const { items: after } = await get<{
      items: { id: string; kind: string; workspaceId: string }[];
    }>('/api/v1/computers');
    expect(after.find((pc) => pc.id === solo.computerId)).toMatchObject({
      kind: 'dedicated',
      workspaceId: solo.workspaceId,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth,
      payload: { name: 'nova', role: 'x', teamId: null },
    });
    expect(again.statusCode).toBe(409);
  });

  it('deletes bots, and teams with their bots, without losing their files', async () => {
    const { app, auth, createBot, services, main, chef, get } = await start();
    const team: Team = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: auth,
        payload: { name: 'Labo' },
      })
    ).json();
    const leo = await createBot({ name: 'Léo', teamId: team.id, computer: 'dedicated' });
    const solo = await createBot({ name: 'Iris', teamId: null });
    await services.files.writeFile(solo.workspaceId as string, 'outputs/note.md', 'à garder');

    const notChef = await app.inject({
      method: 'DELETE',
      url: `/api/v1/bots/${chef.id}`,
      headers: auth,
    });
    expect(notChef.statusCode).toBe(409);
    const notMain = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${main.id}`,
      headers: auth,
    });
    expect(notMain.statusCode).toBe(409);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/bots/${solo.id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    // A team goes with its bots (and their dedicated PCs).
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${team.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(204);
    const { items: left } = await get<{ items: Bot[] }>('/api/v1/bots');
    expect(left.map((b) => b.id)).not.toContain(leo.id);

    const { items: pcs } = await get<{ items: { id: string }[] }>('/api/v1/computers');
    expect(pcs.map((pc) => pc.id)).toEqual([main.computerId]);
    const trash = await services.files.list(main.workspaceId, '.trash');
    const archived = trash.entries.find((e) => e.name.endsWith('-Iris'));
    expect(archived).toBeDefined();
    const kept = await services.files.readText(
      main.workspaceId,
      `.trash/${archived?.name}/outputs/note.md`,
    );
    expect(kept.text).toBe('à garder');
  });
});

describe('starting a team over', () => {
  it('clears every conversation of a team, from the app or by the Chef', async () => {
    const { app, auth, createBot, say, chef, main, conversation } = await start({
      Chef: scripted([
        toolTurn('clear_conversations', { team: 'Équipe principale' }),
        textTurn('C’est vidé.'),
      ]),
      Nova: scripted([textTurn('Salut.')]),
    });
    const nova = await createBot({ name: 'Nova' });
    await say(nova.id, 'Bonjour');
    expect(await conversation(nova.id)).toHaveLength(2);

    // The Chef clears its team, but not its own conversation.
    await say(chef.id, 'Nouveau projet : repars de zéro');
    expect(await conversation(nova.id)).toEqual([]);
    const answer = (await conversation(chef.id)).at(-1);
    const call = answer?.parts.find((p) => p.type === 'tool');
    expect(call).toMatchObject({ toolName: 'clear_conversations', state: 'done' });
    expect(call?.type === 'tool' && call.output).toBe('Conversations vidées : Nova.');

    // The user clears the whole team, the Chef included.
    await say(nova.id, 'Encore');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${main.id}/messages`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(await conversation(nova.id)).toEqual([]);
    expect(await conversation(chef.id)).toEqual([]);
  });
});

describe('bots talking to each other', () => {
  it('delivers a message, wakes the other bot up and shows it in the feed', async () => {
    const chefModel = scripted([
      toolTurn('send_message', { to: 'nova', text: 'Salut !', summary: '  Bonjour   du Chef ' }),
      textTurn('Fait.'),
    ]);
    const novaModel = scripted([textTurn('Bien reçu.')]);
    const { createBot, say, chef, conversation, get } = await start({
      Chef: chefModel,
      Nova: novaModel,
    });
    const nova = await createBot({ name: 'Nova' });
    await say(chef.id, 'Dis bonjour à Nova');

    const [incoming, answer] = await conversation(nova.id);
    expect(incoming).toMatchObject({
      role: 'user',
      fromBotId: chef.id,
      fromName: 'Chef',
      summary: 'Bonjour du Chef',
      kind: 'chat',
      parts: [{ type: 'text', text: 'Salut !' }],
    });
    expect(answer).toMatchObject({ role: 'assistant', status: 'done' });
    expect(promptOf(novaModel, 0)).toContain('[Message de Chef');

    const feed = await get<{ items: FeedItem[] }>('/api/v1/feed');
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({ toBotId: nova.id, fromBotId: chef.id });
  });

  it('lets a bot ask another and wait for the answer', async () => {
    const chefModel = scripted([
      toolTurn('ask_bot', { to: 'Nova', question: 'Quelle heure est-il ?', summary: "L'heure" }),
      textTurn('Nova dit midi.'),
    ]);
    const { createBot, say, chef, events, conversation } = await start({
      Chef: chefModel,
      Nova: scripted([textTurn('Midi pile.')]),
    });
    const nova = await createBot({ name: 'Nova' });
    await say(chef.id, "Demande l'heure à Nova");
    expect(promptOf(chefModel, 1)).toContain('Réponse de Nova :\\nMidi pile.');
    expect((await conversation(nova.id))[0]).toMatchObject({ kind: 'ask', summary: "L'heure" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'bot.updated',
        bot: expect.objectContaining({ id: chef.id, status: 'waiting_bot' }),
      }),
    );
  });

  it('refuses a question that would deadlock', async () => {
    const { createBot, say, chef, conversation } = await start({
      Chef: scripted([toolTurn('ask_bot', { to: 'Nova', question: 'Ça va ?' }), textTurn('Ok.')]),
      Nova: scripted([toolTurn('ask_bot', { to: 'Chef', question: 'Et toi ?' }), textTurn('Oui.')]),
    });
    const nova = await createBot({ name: 'Nova' });
    await say(chef.id, 'Demande à Nova si ça va');
    const answer = (await conversation(nova.id))[1];
    const tool = answer?.parts[0];
    expect(tool).toMatchObject({ type: 'tool', toolName: 'ask_bot', state: 'error' });
    expect(tool?.type === 'tool' && tool.output).toContain('attend déjà une réponse de toi');
  });

  it('stops bots from writing to each other forever', async () => {
    // Both always forward the message, then stop talking.
    const pingPong = (to: string) =>
      scriptedBy((_, call) =>
        call % 2 === 0 ? toolTurn('send_message', { to, text: 'Encore ?' }) : textTurn('…'),
      );
    const { createBot, say, chef, get, conversation } = await start({
      Chef: pingPong('Nova'),
      Nova: pingPong('Chef'),
    });
    const nova = await createBot({ name: 'Nova' });
    await say(chef.id, 'Lance la conversation');

    const feed = await get<{ items: FeedItem[] }>('/api/v1/feed?limit=100');
    expect(feed.items).toHaveLength(MAX_DEPTH);
    const refused = [...(await conversation(chef.id)), ...(await conversation(nova.id))]
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool' && p.state === 'error');
    expect(refused?.type === 'tool' && refused.output).toContain("Trop d'échanges");
  });

  it('does not let a bot keep waking itself with tasks', async () => {
    const { say, chef, get } = await start({
      Chef: scriptedBy((_, call) =>
        call % 2 === 0
          ? toolTurn('assign_task', { to: 'Chef', title: `Encore ${call}` })
          : textTurn('…'),
      ),
    });
    await say(chef.id, 'Organise-toi');
    const { items } = await get<{ items: Task[] }>('/api/v1/tasks');
    expect(items).toHaveLength(MAX_DEPTH);
  });

  it('runs a task from assignment to the result coming back', async () => {
    const taskId = /\(id ([0-9a-f-]{36})\)/;
    const { createBot, say, chef, conversation, get } = await start({
      Chef: scripted([
        toolTurn('assign_task', { to: 'Nova', title: 'Rapport', details: 'Le marché en 1 page' }),
        textTurn('Confié à Nova.'),
        textTurn('Merci Nova.'),
      ]),
      Nova: scriptedBy((prompt, call) =>
        call === 0
          ? toolTurn('update_task', {
              id: taskId.exec(prompt)?.[1],
              status: 'done',
              result: 'Rapport dans outputs/marche.md',
            })
          : textTurn('Terminé.'),
      ),
    });
    const nova = await createBot({ name: 'Nova' });
    await say(chef.id, 'Fais faire un rapport à Nova');

    const { items } = await get<{ items: Task[] }>('/api/v1/tasks');
    expect(items[0]).toMatchObject({
      title: 'Rapport',
      status: 'done',
      result: 'Rapport dans outputs/marche.md',
      assigneeBotId: nova.id,
      creatorBotId: chef.id,
    });
    const report = (await conversation(chef.id)).find((m) => m.kind === 'task');
    expect(report).toMatchObject({
      fromBotId: nova.id,
      taskId: items[0]?.id,
      summary: 'Terminée · Rapport',
    });
    const given = (await conversation(nova.id)).find((m) => m.kind === 'task');
    expect(given).toMatchObject({ fromBotId: chef.id, summary: 'Rapport' });
    expect(report?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('terminée'),
    });
  });

  it('lets the user give a task, and tells the bot when it is cancelled', async () => {
    const novaModel = scripted([textTurn('Je m’y mets.')]);
    const { createBot, app, auth, conversation, services } = await start({ Nova: novaModel });
    const nova = await createBot({ name: 'Nova' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: auth,
      payload: { assigneeBotId: nova.id, title: 'Trier la boîte mail' },
    });
    expect(created.statusCode).toBe(201);
    await services.runtime.settle();
    expect(promptOf(novaModel, 0)).toContain('[De la part de Joris]');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tasks/${created.json().id}`,
      headers: auth,
      payload: { status: 'cancelled' },
    });
    await services.runtime.settle();
    const notices = (await conversation(nova.id)).filter((m) => m.kind === 'task');
    expect(notices).toHaveLength(2);
    expect(notices[1]?.parts[0]).toMatchObject({ text: expect.stringContaining('annulée') });
  });

  it('keeps isolated teams reachable only through their lead or the Chef', async () => {
    const { createBot, app, auth, say, conversation } = await start({
      Nova: scripted([
        toolTurn('send_message', { to: 'Léo', text: 'Psst' }, 'a'),
        toolTurn('send_message', { to: 'Iris', text: 'Bonjour' }, 'b'),
        textTurn('Ok.'),
      ]),
      Iris: scripted([textTurn('Reçu.')]),
    });
    const secret: Team = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: auth,
        payload: { name: 'Secret', isolated: true },
      })
    ).json();
    await createBot({ name: 'Iris', teamId: secret.id, lead: true });
    const leo = await createBot({ name: 'Léo', teamId: secret.id });
    const nova = await createBot({ name: 'Nova' });
    await say(nova.id, 'Écris à Léo puis à Iris');

    const tools = (await conversation(nova.id))
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool');
    expect(tools[0]).toMatchObject({
      state: 'error',
      output: expect.stringContaining('cloisonnée'),
    });
    expect(tools[1]).toMatchObject({ state: 'done' });
    expect(await conversation(leo.id)).toEqual([]);
  });
});

describe('sharing a PC', () => {
  it('makes bots take turns on the screen', async () => {
    const screen = new ScreenLeases(150, 1_000);
    await screen.acquire('pc', { id: 'a', name: 'Nova' });
    const startedAt = Date.now();
    await screen.acquire('pc', { id: 'b', name: 'Iris' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(screen.holder('pc')?.botName).toBe('Iris');

    const impatient = new ScreenLeases(5_000, 200);
    await impatient.acquire('pc', { id: 'a', name: 'Nova' });
    await expect(impatient.acquire('pc', { id: 'b', name: 'Iris' })).rejects.toThrow(
      /utilisé par Nova/,
    );
    impatient.releaseAll('a');
    await expect(impatient.acquire('pc', { id: 'b', name: 'Iris' })).resolves.toBeUndefined();
  });

  it('refuses to write a file another bot has locked', async () => {
    const locks = new FileLocks();
    locks.lock('ws', 'shared/plan.md', { id: 'a', name: 'Nova' });
    expect(() => locks.assertWritable('ws', 'shared/plan.md', 'b')).toThrow(/verrouillé par Nova/);
    expect(() => locks.lock('ws', 'shared/plan.md', { id: 'b', name: 'Iris' })).toThrow();
    expect(locks.unlock('ws', 'shared/plan.md', 'b')).toBe(false);
    locks.releaseAll('a');
    expect(() => locks.assertWritable('ws', 'shared/plan.md', 'b')).not.toThrow();
  });

  it('gives bots sharing a PC the tools to coordinate', async () => {
    const chefModel = scripted([textTurn('Ok.')]);
    const { createBot, say, chef, services, main } = await start({ Chef: chefModel });
    await createBot({ name: 'Nova' });
    services.runtime.locks.lock(main.workspaceId, 'shared/plan.md', { id: 'x', name: 'Nova' });
    await say(chef.id, 'Bonjour');
    const call = chefModel.doStreamCalls[0];
    const toolNames = (call?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'pc_status',
        'lock_file',
        'send_message',
        'create_team',
        'create_bot',
      ]),
    );
    expect(promptOf(chefModel, 0)).toContain('Travailler à plusieurs sur le PC');
  });
});
