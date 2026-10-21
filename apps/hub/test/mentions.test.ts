import type { Bot, FileEntry, Message, Team } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('mentions with @', () => {
  it('hand the bot who and what the user points at, and keep the labels', async () => {
    const model = scripted([textTurn('Vu, je préviens Nova.')]);
    t = await createTestApp({}, undefined, () => model);
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const inject = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: res.json() as T };
    };
    const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
    const team = (await inject<{ items: Team[] }>('GET', '/api/v1/teams')).body.items[0] as Team;
    const nova = (
      await inject<Bot>('POST', '/api/v1/bots', { name: 'Nova', role: 'Veille', teamId: team.id })
    ).body;
    const workspaceId = chef.workspaceId as string;
    await services.files.writeFile(workspaceId, 'outputs/tournois.md', '# Tournois\nSamedi 21/11');
    await services.files.writeFile(workspaceId, 'shared/photo.bin', Buffer.from([0, 1, 2, 3]));

    // What the @ picker lists.
    const search = await inject<{ items: FileEntry[] }>(
      'GET',
      `/api/v1/workspaces/${workspaceId}/files/search?q=TOUR`,
    );
    expect(search.body.items.map((e) => e.path)).toEqual(['outputs/tournois.md']);
    const latest = await inject<{ items: FileEntry[] }>(
      'GET',
      `/api/v1/workspaces/${workspaceId}/files/search`,
    );
    expect(latest.body.items.map((e) => e.path)).toContain('shared/photo.bin');

    const sent = await inject<Message>('POST', `/api/v1/bots/${chef.id}/messages`, {
      text: 'Dis à @Nova de regarder @outputs/tournois.md avec @Équipe principale',
      mentions: [
        { kind: 'bot', id: nova.id },
        { kind: 'file', path: 'outputs/tournois.md' },
        { kind: 'team', id: team.id },
        { kind: 'file', path: 'shared/photo.bin' },
        { kind: 'file', path: 'gone.md' },
      ],
    });
    expect(sent.status).toBe(202);
    await services.runtime.settle();

    const prompt = promptOf(model, 0);
    expect(prompt).toContain('[Mentionnés avec @]');
    expect(prompt).toContain('@Nova : le bot Nova (Veille, équipe Équipe principale)');
    expect(prompt).toContain('/workspace/outputs/tournois.md');
    expect(prompt).toContain('Samedi 21/11');
    expect(prompt).toContain('menée par Chef');
    // Not text: only its path.
    expect(prompt).toContain('/workspace/shared/photo.bin (4 o), à ouvrir sur ton PC');
    expect(prompt).not.toContain('gone.md');

    const [message] = (
      await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)
    ).body.items;
    // The app shows what the user wrote, with what each @ points at.
    expect(message?.parts).toEqual([
      {
        type: 'text',
        text: 'Dis à @Nova de regarder @outputs/tournois.md avec @Équipe principale',
      },
    ]);
    expect(message?.mentions).toEqual([
      { kind: 'bot', id: nova.id, label: 'Nova' },
      { kind: 'file', path: 'outputs/tournois.md', label: 'outputs/tournois.md' },
      { kind: 'team', id: team.id, label: 'Équipe principale' },
      { kind: 'file', path: 'shared/photo.bin', label: 'shared/photo.bin' },
    ]);
  });
});
