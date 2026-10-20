import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Computer, ServerEvent, Team } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computers } from '../src/db/schema';
import { bearer, createTestApp, setupOwner } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
let token: string;
let team: Team;
let events: ServerEvent[];

beforeEach(async () => {
  t = await createTestApp();
  token = (await setupOwner(t.app)).accessToken;
  team = (await get('/api/v1/teams')).json().items[0];
  events = [];
  t.services.events.subscribe((event) => events.push(event));
});

afterEach(async () => {
  await t.close();
});

function get(url: string) {
  return t.app.inject({ method: 'GET', url, headers: bearer(token) });
}

function post(url: string, payload?: unknown) {
  return t.app.inject({ method: 'POST', url, headers: bearer(token), payload: payload as object });
}

async function startComputer(id: string): Promise<Computer> {
  const res = await post(`/api/v1/computers/${id}/start`);
  expect(res.statusCode).toBe(200);
  await t.services.computers.waitForBoot(id);
  return (await get(`/api/v1/computers/${id}`)).json();
}

describe('main team', () => {
  it('is created at setup with its workspace folders and shared computer', async () => {
    expect(team).toMatchObject({ name: 'Équipe principale', isMain: true });
    expect(team.computerId).toBeTruthy();
    const folders = await readdir(path.join(t.workspacesDir, team.workspaceId));
    expect(folders.sort()).toEqual(['.trash', 'bots', 'inbox', 'kb', 'outputs', 'shared']);

    const pcs = (await get('/api/v1/computers')).json().items;
    expect(pcs).toHaveLength(1);
    expect(pcs[0]).toMatchObject({
      kind: 'team',
      teamId: team.id,
      status: 'stopped',
      control: null,
    });
  });

  it('is created at startup for instances set up before P1', async () => {
    // Bootstrapping twice must not duplicate anything.
    const { ensureMainTeam } = await import('../src/teams/bootstrap');
    await ensureMainTeam(t.services.db, t.services.files, t.services.config.masterKey);
    expect((await get('/api/v1/teams')).json().items).toHaveLength(1);
  });
});

describe('computer lifecycle', () => {
  it('starts in the background and reports progress through events', async () => {
    const id = team.computerId as string;
    const starting = await post(`/api/v1/computers/${id}/start`);
    expect(starting.json().status).toBe('starting');
    await t.services.computers.waitForBoot(id);

    expect((await get(`/api/v1/computers/${id}`)).json().status).toBe('running');
    const statuses = events
      .filter((e) => e.type === 'computer.updated')
      .map((e) => (e.type === 'computer.updated' ? e.computer.status : null));
    expect(statuses[0]).toBe('starting');
    expect(statuses.at(-1)).toBe('running');
  });

  it('mounts the team workspace in the computer', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    expect(t.runtime.machines.get(`fake-${id}`)?.workspaceId).toBe(team.workspaceId);
  });

  it('records a failed start with its reason', async () => {
    t.runtime.failNextStart = new Error('Image mowbot/workstation:local not found');
    const computer = await startComputer(team.computerId as string);
    expect(computer).toMatchObject({
      status: 'error',
      statusDetail: 'Image mowbot/workstation:local not found',
    });
  });

  it('stops and clears control', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    await post(`/api/v1/computers/${id}/takeover`);
    const stopped = (await post(`/api/v1/computers/${id}/stop`)).json();
    expect(stopped).toMatchObject({ status: 'stopped', control: null });
    expect(await t.runtime.isRunning(`fake-${id}`)).toBe(false);
  });

  it('requires the control scope to start', async () => {
    const { token: readOnly } = await t.services.tokens.sign({
      ownerId: (await get('/api/v1/me')).json().owner.id,
      deviceId: (await get('/api/v1/me')).json().device.id,
      scopes: ['read'],
    });
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/computers/${team.computerId}/start`,
      headers: bearer(readOnly),
    });
    expect(res.statusCode).toBe(403);
  });

  it('reconciles stale statuses after a hub restart', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    await t.runtime.stop(`fake-${id}`); // the container died while the hub was down
    await t.services.computers.reconcile();
    expect((await get(`/api/v1/computers/${id}`)).json().status).toBe('stopped');
  });
});

describe('takeover', () => {
  it('locks the agent input while the user has control', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    const agentState = t.runtime.machines.get(`fake-${id}`)?.agent.state;

    const taken = (await post(`/api/v1/computers/${id}/takeover`)).json();
    expect(taken.control?.deviceId).toBe((await get('/api/v1/me')).json().device.id);
    expect(agentState?.controlLocked).toBe(true);

    const released = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/computers/${id}/takeover`,
      headers: bearer(token),
    });
    expect(released.json().control).toBeNull();
    expect(agentState?.controlLocked).toBe(false);
  });

  it('hands control back when the controlling device closes its desktop', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    const { ticket } = (await post(`/api/v1/computers/${id}/desktop-ticket`)).json();
    const ws = await t.app.injectWS(`/api/v1/computers/${id}/desktop?ticket=${ticket}`);
    const echoed = new Promise((resolve) => ws.once('message', resolve));
    ws.send(Buffer.from('ping'));
    await echoed; // the VNC upstream is open
    await post(`/api/v1/computers/${id}/takeover`);

    ws.terminate();
    await vi.waitFor(async () => {
      expect((await get(`/api/v1/computers/${id}`)).json().control).toBeNull();
    });
    expect(t.runtime.machines.get(`fake-${id}`)?.agent.state.controlLocked).toBe(false);
  });

  it('refuses takeover of a stopped computer', async () => {
    const res = await post(`/api/v1/computers/${team.computerId}/takeover`);
    expect(res.statusCode).toBe(409);
  });
});

describe('desktop stream', () => {
  it('proxies RFB bytes to the computer through a one-time ticket', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    const { ticket } = (await post(`/api/v1/computers/${id}/desktop-ticket`)).json();

    const ws = await t.app.injectWS(`/api/v1/computers/${id}/desktop?ticket=${ticket}`);
    const echoed = new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(data.toString())),
    );
    ws.send(Buffer.from('RFB 003.008\n'));
    expect(await echoed).toBe('RFB 003.008\n');
    ws.terminate();

    // Single use.
    const reused = await t.app.injectWS(`/api/v1/computers/${id}/desktop?ticket=${ticket}`);
    const code = await new Promise<number>((resolve) => reused.once('close', resolve));
    expect(code).toBe(1008);
  });
});

describe('hibernation', () => {
  it('stops computers idle for too long, unless a desktop is open', async () => {
    const id = team.computerId as string;
    await startComputer(id);
    await t.services.db
      .update(computers)
      .set({ lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(computers.id, id));

    t.services.computers.desktopOpened(id, 'device-a');
    expect(await t.services.computers.hibernateIdle()).toEqual([]);

    t.services.computers.desktopClosed(id, 'device-a');
    await t.services.db
      .update(computers)
      .set({ lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(computers.id, id));
    expect(await t.services.computers.hibernateIdle()).toEqual([id]);
    expect((await get(`/api/v1/computers/${id}`)).json().status).toBe('stopped');
  });
});

describe('events stream', () => {
  it('sends ready then server events', async () => {
    const { ticket } = (await post('/api/v1/events/ticket')).json();
    const messages: ServerEvent[] = [];
    let resolveTwo: () => void = () => {};
    const twoMessages = new Promise<void>((resolve) => {
      resolveTwo = resolve;
    });
    // Listen before the socket opens: `ready` is sent right away.
    const ws = await t.app.injectWS(
      `/api/v1/events?ticket=${ticket}`,
      {},
      {
        onInit: (socket) =>
          socket.on('message', (data) => {
            messages.push(JSON.parse(data.toString()));
            if (messages.length === 2) resolveTwo();
          }),
      },
    );
    await post(`/api/v1/computers/${team.computerId}/start`);
    await twoMessages;
    expect(messages[0]).toEqual({ type: 'ready' });
    expect(messages[1]).toMatchObject({
      type: 'computer.updated',
      computer: { status: 'starting' },
    });
    ws.terminate();
    await t.services.computers.waitForBoot(team.computerId as string);
  });
});
