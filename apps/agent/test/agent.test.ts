import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { type Agent, createAgent, type Runner, xdotoolCommands } from '../src/server';

const TOKEN = 'agent-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let agent: Agent;
let base: string;
let vnc: net.Server;
let calls: { command: string; args: string[] }[];

beforeEach(async () => {
  // Fake VNC server: echoes everything back.
  vnc = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => vnc.listen(0, '127.0.0.1', resolve));
  calls = [];
  const run: Runner = async (command, args) => {
    calls.push({ command, args });
    return { exitCode: 0, stdout: `ran ${command}`, stderr: '', timedOut: false };
  };
  agent = createAgent({ token: TOKEN, vncPort: (vnc.address() as net.AddressInfo).port, run });
  const address = await agent.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await agent.close();
  await new Promise((resolve) => vnc.close(resolve));
});

const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('mow-agent', () => {
  it('rejects requests without the token', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/health`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });

  it('reports health including VNC reachability', async () => {
    const res = await fetch(`${base}/health`, { headers: auth });
    expect(await res.json()).toEqual({ ok: true, vnc: true, controlLocked: false });
  });

  it('refuses input while the user has control', async () => {
    expect((await post('/input', { action: 'click', x: 10, y: 20 })).status).toBe(200);
    expect(calls.map((c) => c.args)).toEqual([
      ['mousemove', '--sync', '10', '20'],
      ['click', '1'],
    ]);

    await post('/control', { locked: true });
    const locked = await post('/input', { action: 'key', keys: 'ctrl+l' });
    expect(locked.status).toBe(423);

    await post('/control', { locked: false });
    expect((await post('/input', { action: 'key', keys: 'ctrl+l' })).status).toBe(200);
  });

  it('validates input actions', async () => {
    expect((await post('/input', { action: 'teleport' })).status).toBe(400);
  });

  it('runs shell commands through bash', async () => {
    const res = await post('/exec', { command: 'echo hi' });
    expect(await res.json()).toMatchObject({ exitCode: 0, stdout: 'ran bash' });
    expect(calls[0]).toEqual({ command: 'bash', args: ['-lc', 'echo hi'] });
  });

  it('bridges the VNC WebSocket to the VNC server', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/vnc`, { headers: auth });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const echoed = new Promise<Buffer>((resolve) =>
      ws.once('message', (data) => resolve(data as Buffer)),
    );
    ws.send(Buffer.from('RFB 003.008\n'));
    expect((await echoed).toString()).toBe('RFB 003.008\n');
    ws.close();
  });

  it('bridges the DevTools WebSocket to Chrome', async () => {
    // Fake Chrome: /json/version points to a WebSocket that answers every command.
    const devtools = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    devtools.on('connection', (socket) =>
      socket.on('message', (data) => {
        const { id } = JSON.parse(String(data)) as { id: number };
        socket.send(JSON.stringify({ id, result: { product: 'Chrome/155' } }));
      }),
    );
    await new Promise((resolve) => devtools.once('listening', resolve));
    const wsPort = (devtools.address() as net.AddressInfo).port;
    const http = await import('node:http');
    const versions = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/browser/x` }),
      );
    });
    await new Promise<void>((resolve) => versions.listen(0, '127.0.0.1', resolve));
    const cdpAgent = createAgent({
      token: TOKEN,
      devtoolsUrl: `http://127.0.0.1:${(versions.address() as net.AddressInfo).port}`,
    });
    const { port } = await cdpAgent.listen(0, '127.0.0.1');
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`, { headers: auth });
      // Sent before Chrome is connected: kept until it is.
      ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })));
      const reply = await new Promise<string>((resolve) =>
        ws.once('message', (data) => resolve(String(data))),
      );
      expect(JSON.parse(reply)).toEqual({ id: 1, result: { product: 'Chrome/155' } });
      ws.close();
    } finally {
      await cdpAgent.close();
      versions.close();
      devtools.close();
    }
  });

  it('refuses the VNC WebSocket without the token', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/vnc`);
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(401);
  });
});

describe('xdotoolCommands', () => {
  it('maps scroll and drag', () => {
    expect(xdotoolCommands({ action: 'scroll', direction: 'down', amount: 2 })).toEqual([
      ['click', '--repeat', '2', '5'],
    ]);
    expect(xdotoolCommands({ action: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toEqual([
      ['mousemove', '--sync', '1', '2'],
      ['mousedown', '1'],
      ['mousemove', '--sync', '3', '4'],
      ['mouseup', '1'],
    ]);
  });
});
