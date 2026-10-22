import type { Bot, Computer, Team } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGpus, setupKey } from '../src/computers/runtime';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const CARD = {
  id: 'GPU-8cf1b926-2d8e-b80b-301f-47a0ec45fd0a',
  index: 0,
  name: 'NVIDIA GeForce RTX 3050 Ti Laptop GPU',
  memoryMb: 4096,
};

async function start(models: Record<string, ReturnType<typeof scripted>> = {}) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const team = (await call<{ items: Team[] }>('GET', '/api/v1/teams')).body.items[0] as Team;
  const boot = async (id: string) => {
    await call('POST', `/api/v1/computers/${id}/start`);
    await services.computers.waitForBoot(id);
    return (await call<Computer>('GET', `/api/v1/computers/${id}`)).body;
  };
  return { app, services, runtime, call, team, boot };
}

describe('the system of a PC', () => {
  it('runs without a desktop, then takes a new setup when it restarts', async () => {
    const { call, team, boot, runtime } = await start();
    const id = team.computerId as string;
    const before = (await call<Computer>('GET', `/api/v1/computers/${id}`)).body;
    expect(before).toMatchObject({ system: 'desktop', gpus: null, restartNeeded: false });

    const changed = await call<Computer>('PATCH', `/api/v1/computers/${id}`, {
      system: 'terminal',
    });
    expect(changed.body).toMatchObject({ system: 'terminal', restartNeeded: false });
    // No screen to wait for: it boots all the same.
    const running = await boot(id);
    expect(running).toMatchObject({ status: 'running', restartNeeded: false });
    expect(runtime.machines.get(`fake-${id}`)).toMatchObject({ system: 'terminal', vnc: null });

    // Changed while it runs: for its next start.
    const back = await call<Computer>('PATCH', `/api/v1/computers/${id}`, { system: 'desktop' });
    expect(back.body).toMatchObject({ system: 'desktop', restartNeeded: true });
  });

  it('hands out the host cards it may, and only those', async () => {
    const { call, team, boot, runtime } = await start();
    const id = team.computerId as string;
    expect((await call('GET', '/api/v1/computers/gpus')).body).toEqual({
      available: false,
      items: [],
    });
    expect(await call('PATCH', `/api/v1/computers/${id}`, { gpus: 'all' })).toMatchObject({
      status: 400,
      body: { type: 'urn:mowbot:problem:gpu_unavailable' },
    });

    runtime.gpuList = { available: true, items: [CARD] };
    expect((await call('GET', '/api/v1/computers/gpus')).body).toEqual(runtime.gpuList);
    expect(
      await call('PATCH', `/api/v1/computers/${id}`, { gpus: ['GPU-not-there'] }),
    ).toMatchObject({ status: 400, body: { type: 'urn:mowbot:problem:unknown_gpu' } });
    const given = await call<Computer>('PATCH', `/api/v1/computers/${id}`, { gpus: [CARD.id] });
    expect(given.body).toMatchObject({ gpus: [CARD.id] });
    await boot(id);
    expect(runtime.machines.get(`fake-${id}`)?.gpus).toEqual([CARD.id]);

    // Taken away again.
    const none = await call<Computer>('PATCH', `/api/v1/computers/${id}`, { gpus: null });
    expect(none.body).toMatchObject({ gpus: null, restartNeeded: true });
  });

  it('lets a new team pick its PC', async () => {
    const { call, runtime } = await start();
    runtime.gpuList = { available: true, items: [CARD] };
    const team = await call<Team>('POST', '/api/v1/teams', {
      name: 'Calcul',
      computer: { system: 'terminal', gpus: 'all' },
    });
    expect(team.status).toBe(201);
    const pc = await call<Computer>('GET', `/api/v1/computers/${team.body.computerId}`);
    expect(pc.body).toMatchObject({ system: 'terminal', gpus: 'all' });
  });

  it('gives the bots of a PC without a screen no screen tools, and tells them its cards', async () => {
    const model = scripted([textTurn('Ok.')]);
    const { call, team, runtime } = await start({ Kai: model });
    runtime.gpuList = { available: true, items: [CARD] };
    await call('PATCH', `/api/v1/computers/${team.computerId}`, {
      system: 'terminal',
      gpus: 'all',
    });
    const kai = await call<Bot>('POST', '/api/v1/bots', {
      name: 'Kai',
      role: 'Data scientist',
      teamId: team.id,
    });
    await call('POST', `/api/v1/bots/${kai.body.id}/messages`, { text: 'Bonjour' });
    await t?.services.runtime.settle();

    const tools = (model.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['bash', 'browser_open']));
    expect(tools).not.toContain('screenshot');
    expect(tools).not.toContain('computer');
    expect(tools).not.toContain('request_takeover');
    const prompt = promptOf(model, 0);
    expect(prompt).toContain('sans écran (ligne de commande seulement');
    expect(prompt).toContain(
      'Carte graphique NVIDIA : NVIDIA GeForce RTX 3050 Ti Laptop GPU (4 Go)',
    );
    expect(prompt).not.toContain('bureau XFCE');
  });
});

describe('PC setups', () => {
  it('are keyed by system and cards, in any order', () => {
    expect(setupKey({ system: 'desktop', gpus: null })).toBe('desktop;');
    expect(setupKey({ system: 'terminal', gpus: ['b', 'a'] })).toBe(
      setupKey({ system: 'terminal', gpus: ['a', 'b'] }),
    );
    expect(setupKey({ system: 'desktop', gpus: 'all' })).not.toBe(
      setupKey({ system: 'desktop', gpus: null }),
    );
  });

  it('read the cards nvidia-smi lists', () => {
    expect(
      parseGpus(
        '0, GPU-8cf1b926-2d8e-b80b-301f-47a0ec45fd0a, NVIDIA GeForce RTX 3050 Ti Laptop GPU, 4096\r\n1, GPU-1111, Tesla T4, [N/A]\n\n',
      ),
    ).toEqual([CARD, { id: 'GPU-1111', index: 1, name: 'Tesla T4', memoryMb: null }]);
    expect(parseGpus('No devices were found')).toEqual([]);
  });
});
