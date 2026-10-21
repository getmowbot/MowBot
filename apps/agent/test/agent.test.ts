import http from 'node:http';
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

/** Opens /tcp to `port`: the raw socket after a 101, or the status and body of a refusal. */
function openTcp(
  port: number | string,
  headers: Record<string, string> = auth,
  upgrade = 'mowbot-tcp',
): Promise<{ status: number; socket?: net.Socket; body?: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/tcp?port=${port}`, {
      headers: { ...headers, connection: 'Upgrade', upgrade },
    });
    request.on('upgrade', (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    request.on('response', (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('TCP relay (/tcp)', () => {
  let target: http.Server;
  let targetPort: number;
  let seen: { host?: string; cookie?: string }[];

  beforeEach(async () => {
    seen = [];
    // A dev server inside the computer, bound to the loopback only.
    target = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, cookie: req.headers.cookie });
      res.setHeader('content-type', 'text/plain');
      res.end(`hello from ${req.url}`);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  });

  it('carries HTTP to a loopback port, several requests on one tunnel', async () => {
    const { status, socket } = await openTcp(targetPort);
    expect(status).toBe(101);
    // One tunnel serves as a keep-alive connection for successive requests.
    const agentPool = new http.Agent({ keepAlive: true, maxSockets: 1 });
    Object.assign(agentPool, { createConnection: () => socket });
    const get = (path: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get({ agent: agentPool, host: 'localhost', port: targetPort, path }, (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
    expect(await get('/a')).toBe('hello from /a');
    expect(await get('/b')).toBe('hello from /b');
    expect(seen).toHaveLength(2);
    agentPool.destroy();
  });

  it('needs the token', async () => {
    expect((await openTcp(targetPort, {})).status).toBe(401);
    expect((await openTcp(targetPort, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('refuses invalid and reserved ports', async () => {
    expect((await openTcp('nope')).status).toBe(400);
    expect((await openTcp(70_000)).status).toBe(400);
    // VNC, Chrome DevTools, X11 and the agent itself stay behind the agent.
    expect((await openTcp((vnc.address() as net.AddressInfo).port)).status).toBe(403);
    expect((await openTcp(9222)).status).toBe(403);
    expect((await openTcp(6000)).status).toBe(403);
    expect((await openTcp(new URL(base).port)).status).toBe(403);
    // Only the raw relay upgrade.
    expect((await openTcp(targetPort, auth, 'websocket')).status).toBe(400);
  });

  it('reports a closed port', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const refused = await openTcp(port);
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body ?? '{}')).toEqual({ error: `Nothing listens on port ${port}` });
  });

  it('closes open tunnels when the agent stops', async () => {
    const { socket } = await openTcp(targetPort);
    const closed = new Promise((resolve) => socket?.once('close', resolve));
    await agent.close();
    await closed;
    // afterEach closes it again: start a fresh one.
    agent = createAgent({ token: TOKEN });
    base = `http://127.0.0.1:${(await agent.listen(0, '127.0.0.1')).port}`;
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
