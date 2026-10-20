import type { Bot, Computer, Message, Team } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(models: Record<string, MockLanguageModelV4> = {}) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await call<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const main = (await call<{ items: Team[] }>('GET', '/api/v1/teams')).body.items[0] as Team;
  const marketing = (
    await call<Team>('POST', '/api/v1/teams', { name: 'Marketing', mission: 'Vendre' })
  ).body;
  const nova = (
    await call<Bot>('POST', '/api/v1/bots', {
      name: 'Nova',
      role: 'Rédactrice',
      teamId: marketing.id,
      lead: true,
    })
  ).body;
  await services.files.writeFile(marketing.workspaceId, 'bots/nova/notes.md', '# Notes');
  const say = async (botId: string, text: string) => {
    await call('POST', `/api/v1/bots/${botId}/messages`, { text });
    await services.runtime.settle();
  };
  const conversation = async (botId: string) =>
    (await call<{ items: Message[] }>('GET', `/api/v1/bots/${botId}/messages`)).body.items;
  const exists = (workspaceId: string, file: string) =>
    services.files.stat(workspaceId, file).then(
      () => true,
      () => false,
    );
  return { call, services, chef, main, marketing, nova, say, conversation, exists };
}

describe('sharing files between teams', () => {
  it('copies into the other team’s inbox and tells its lead', async () => {
    const chefModel = scripted([
      toolTurn('write_file', { path: '/workspace/outputs/brief.md', content: '# Brief' }, 'w'),
      toolTurn(
        'share_file',
        { path: '/workspace/outputs/brief.md', to: 'Marketing', note: 'Pour la campagne' },
        's',
      ),
      textTurn('Envoyé à Marketing.'),
    ]);
    const { say, chef, nova, marketing, exists, conversation } = await start({
      Chef: chefModel,
      Nova: scripted([textTurn('Bien reçu.')]),
    });
    await say(chef.id, 'Passe le brief au marketing');

    expect(await exists(marketing.workspaceId, 'inbox/chef/brief.md')).toBe(true);
    expect(promptOf(chefModel, 2)).toContain("Copié chez l'équipe Marketing");
    const received = (await conversation(nova.id)).find((m) => m.fromBotId === chef.id);
    expect(received?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/workspace/inbox/chef/brief.md'),
    });
  });

  it('refuses to share within the same workspace', async () => {
    const chefModel = scripted([
      toolTurn('write_file', { path: '/workspace/a.md', content: 'a' }, 'w'),
      toolTurn('share_file', { path: '/workspace/a.md', to: 'Équipe principale' }, 's'),
      textTurn('Ok.'),
    ]);
    const { say, chef } = await start({ Chef: chefModel });
    await say(chef.id, 'Partage');
    expect(promptOf(chefModel, 2)).toContain('voit déjà tes fichiers');
  });
});

describe('moving a bot', () => {
  it('makes a bot solo, then brings it into another team with its folder', async () => {
    const { call, nova, marketing, main, exists, services } = await start();

    const solo = await call<Bot>('POST', `/api/v1/bots/${nova.id}/move`, { teamId: null });
    expect(solo.status).toBe(200);
    expect(solo.body.teamId).toBeNull();
    expect(solo.body.workspaceId).not.toBe(marketing.workspaceId);
    expect(await exists(solo.body.workspaceId as string, 'bots/nova/notes.md')).toBe(true);
    expect(await exists(marketing.workspaceId, 'bots/nova')).toBe(false);
    const teams = (await call<{ items: Team[] }>('GET', '/api/v1/teams')).body.items;
    expect(teams.find((x) => x.id === marketing.id)?.leadBotId).toBeNull();
    const pcs = (await call<{ items: Computer[] }>('GET', '/api/v1/computers')).body.items;
    expect(pcs.find((pc) => pc.id === solo.body.computerId)).toMatchObject({
      kind: 'dedicated',
      teamId: null,
    });

    const back = await call<Bot>('POST', `/api/v1/bots/${nova.id}/move`, {
      teamId: main.id,
      computer: 'team',
    });
    expect(back.body).toMatchObject({
      teamId: main.id,
      workspaceId: main.workspaceId,
      computerId: main.computerId,
    });
    expect(await exists(main.workspaceId, 'bots/nova/notes.md')).toBe(true);
    // Its solo workspace and dedicated PC are gone; nothing is lost (main team's trash).
    const after = (await call<{ items: Computer[] }>('GET', '/api/v1/computers')).body.items;
    expect(after.some((pc) => pc.id === solo.body.computerId)).toBe(false);
    const trash = await services.files.list(main.workspaceId, '.trash');
    expect(trash.entries.some((e) => e.name.includes('espace solo de Nova'))).toBe(true);
  });

  it('keeps the Chef in the main team', async () => {
    const { call, chef, marketing } = await start();
    const res = await call('POST', `/api/v1/bots/${chef.id}/move`, { teamId: marketing.id });
    expect(res.status).toBe(409);
  });
});
