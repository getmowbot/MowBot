import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunResult>;

export interface AgentOptions {
  token: string;
  vncHost?: string;
  vncPort?: number;
  display?: string;
  /** Default working directory for `exec`. */
  workdir?: string;
  /** Chrome's DevTools HTTP endpoint (local to the computer). */
  devtoolsUrl?: string;
  /** Process runner, replaced in tests. */
  run?: Runner;
  /** Starts a long-lived process for /stdio (an MCP server), replaced in tests. */
  spawnStdio?: (command: string, env: Record<string, string>) => ChildProcessWithoutNullStreams;
}

export interface Agent {
  readonly state: { controlLocked: boolean };
  listen(port: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Spawns a process and collects (truncated) output. */
export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes < MAX_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errBytes < MAX_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
        stderr: Buffer.concat(err).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
        timedOut,
      });
    });
  });

const point = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), ...point.shape }),
  z.object({
    action: z.literal('click'),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    button: z.enum(['left', 'middle', 'right']).default('left'),
    double: z.boolean().default(false),
  }),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(10_000) }),
  z.object({ action: z.literal('key'), keys: z.string().min(1).max(200) }),
  z.object({
    action: z.literal('scroll'),
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(20).default(3),
  }),
  z.object({ action: z.literal('drag'), from: point, to: point }),
]);
export type InputAction = z.infer<typeof inputSchema>;

const BUTTONS = { left: '1', middle: '2', right: '3' } as const;
const SCROLL_BUTTONS = { up: '4', down: '5', left: '6', right: '7' } as const;

/** Translates an input action into xdotool argument lists, run in order. */
export function xdotoolCommands(input: InputAction): string[][] {
  const moveTo = (x?: number, y?: number) =>
    x !== undefined && y !== undefined ? [['mousemove', '--sync', String(x), String(y)]] : [];
  switch (input.action) {
    case 'move':
      return moveTo(input.x, input.y);
    case 'click':
      return [
        ...moveTo(input.x, input.y),
        ['click', ...(input.double ? ['--repeat', '2'] : []), BUTTONS[input.button]],
      ];
    case 'type':
      return [['type', '--delay', '12', '--', input.text]];
    case 'key':
      return [['key', '--', ...input.keys.split(/\s+/)]];
    case 'scroll':
      return [
        ...moveTo(input.x, input.y),
        ['click', '--repeat', String(input.amount), SCROLL_BUTTONS[input.direction]],
      ];
    case 'drag':
      return [
        ...moveTo(input.from.x, input.from.y),
        ['mousedown', '1'],
        ...moveTo(input.to.x, input.to.y),
        ['mouseup', '1'],
      ];
  }
}

const controlSchema = z.object({ locked: z.boolean() });
const execSchema = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Body too large'));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

function canConnect(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Pipes an RFB WebSocket to the local VNC server. */
/** What the hub and a /stdio process exchange, one JSON frame per line of the process. */
type StdioFrame =
  | { t: 'start'; command: string; env?: Record<string, string> }
  | { t: 'in'; d: string }
  | { t: 'out'; d: string }
  | { t: 'err'; d: string }
  | { t: 'exit'; code: number | null };

const MAX_STDIO_LINE = 4 * 1024 * 1024;

/**
 * A long-lived process (an MCP server speaking JSON-RPC over stdio) bridged to a WebSocket:
 * the first frame starts it, then lines in and out; it is killed when the socket closes.
 */
function bridgeStdio(
  ws: WebSocket,
  start: (command: string, env: Record<string, string>) => ChildProcessWithoutNullStreams,
): void {
  const send = (frame: StdioFrame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  let child: ChildProcessWithoutNullStreams | null = null;
  ws.on('message', (data: Buffer) => {
    let frame: StdioFrame;
    try {
      frame = JSON.parse(data.toString()) as StdioFrame;
    } catch {
      return;
    }
    if (frame.t === 'start' && !child) {
      child = start(frame.command, frame.env ?? {});
      let buffered = '';
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, '');
          buffered = buffered.slice(newline + 1);
          if (line.trim()) send({ t: 'out', d: line });
          newline = buffered.indexOf('\n');
        }
        if (buffered.length > MAX_STDIO_LINE) buffered = '';
      });
      child.stderr.on('data', (chunk: Buffer) =>
        send({ t: 'err', d: chunk.toString().slice(-4_000) }),
      );
      child.on('error', (error) => {
        send({ t: 'err', d: error.message });
        send({ t: 'exit', code: null });
        ws.close();
      });
      child.on('exit', (code) => {
        send({ t: 'exit', code });
        ws.close();
      });
    } else if (frame.t === 'in' && child) {
      child.stdin.write(`${frame.d}\n`);
    }
  });
  ws.on('close', () => child?.kill());
  ws.on('error', () => child?.kill());
}

function bridgeVnc(ws: WebSocket, host: string, port: number): void {
  const tcp = net.connect({ host, port });
  ws.on('message', (data: Buffer) => tcp.write(data));
  tcp.on('data', (data) => ws.send(data, { binary: true }));
  const closeAll = () => {
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };
  ws.on('close', closeAll);
  ws.on('error', closeAll);
  tcp.on('close', closeAll);
  tcp.on('error', closeAll);
}

/**
 * Relays a client (the hub's browser automation) to Chrome's browser-level DevTools socket, which
 * only listens on the computer's loopback. Messages are passed through untouched.
 */
async function bridgeCdp(ws: WebSocket, devtoolsUrl: string): Promise<void> {
  const pending: Buffer[] = [];
  const queue = (data: Buffer) => pending.push(data);
  ws.on('message', queue);
  let chrome: WebSocket;
  try {
    const version = (await (await fetch(`${devtoolsUrl}/json/version`)).json()) as {
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) throw new Error('Chrome has no DevTools socket');
    chrome = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  } catch {
    ws.close(1011, 'Chrome is not reachable');
    return;
  }
  const closeAll = () => {
    if (chrome.readyState === chrome.OPEN || chrome.readyState === chrome.CONNECTING)
      chrome.close();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  };
  chrome.on('open', () => {
    ws.off('message', queue);
    for (const data of pending.splice(0)) chrome.send(data.toString());
    ws.on('message', (data: Buffer) => chrome.send(data.toString()));
  });
  chrome.on('message', (data: Buffer) => ws.send(data.toString()));
  chrome.on('close', closeAll);
  chrome.on('error', closeAll);
  ws.on('close', closeAll);
  ws.on('error', closeAll);
}

export function createAgent(options: AgentOptions): Agent {
  const vncHost = options.vncHost ?? '127.0.0.1';
  const vncPort = options.vncPort ?? 5900;
  const display = options.display ?? ':0';
  const run = options.run ?? spawnRunner;
  const spawnStdio =
    options.spawnStdio ??
    ((command: string, env: Record<string, string>) =>
      spawn('bash', ['-lc', command], {
        cwd: options.workdir,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
  const tokenDigest = digest(options.token);
  const state = { controlLocked: false };
  const x11Env = { DISPLAY: display };

  const authorized = (header: string | undefined) => {
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return timingSafeEqual(digest(token), tokenDigest);
  };

  const routes: Record<string, (request: http.IncomingMessage) => Promise<unknown>> = {
    'GET /health': async () => ({
      ok: true,
      vnc: await canConnect(vncHost, vncPort),
      controlLocked: state.controlLocked,
    }),

    'POST /control': async (request) => {
      state.controlLocked = parse(controlSchema, await readJson(request)).locked;
      return { controlLocked: state.controlLocked };
    },

    'POST /exec': async (request) => {
      const body = parse(execSchema, await readJson(request));
      return run('bash', ['-lc', body.command], {
        cwd: body.cwd ?? options.workdir,
        timeoutMs: body.timeoutMs,
        env: x11Env,
      });
    },

    'POST /input': async (request) => {
      if (state.controlLocked) throw new HttpError(423, 'The user has control of the desktop');
      const input = parse(inputSchema, await readJson(request));
      for (const args of xdotoolCommands(input)) {
        const result = await run('xdotool', args, { env: x11Env, timeoutMs: 15_000 });
        if (result.exitCode !== 0)
          throw new HttpError(500, `xdotool failed: ${result.stderr.trim()}`);
      }
      return { ok: true };
    },
  };

  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request.headers.authorization)) return send(401, { error: 'Unauthorized' });

    const route = `${request.method} ${new URL(request.url ?? '/', 'http://agent').pathname}`;
    if (route === 'GET /screenshot') {
      const file = path.join(tmpdir(), `mowbot-shot-${randomBytes(6).toString('hex')}.png`);
      run('scrot', ['--overwrite', file], { env: x11Env, timeoutMs: 15_000 })
        .then(async (result) => {
          if (result.exitCode !== 0)
            throw new HttpError(500, `scrot failed: ${result.stderr.trim()}`);
          const png = await readFile(file);
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
          response.end(png);
        })
        .catch((error: Error) =>
          send(error instanceof HttpError ? error.status : 500, { error: error.message }),
        )
        .finally(() => rm(file, { force: true }));
      return;
    }

    const handler = routes[route];
    if (!handler) return send(404, { error: 'Not found' });
    handler(request)
      .then((body) => send(200, body))
      .catch((error: Error) =>
        send(error instanceof HttpError ? error.status : 500, { error: error.message }),
      );
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://agent').pathname;
    const known = pathname === '/vnc' || pathname === '/cdp' || pathname === '/stdio';
    if (!known || !authorized(request.headers.authorization)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (pathname === '/vnc') bridgeVnc(ws, vncHost, vncPort);
      else if (pathname === '/stdio') bridgeStdio(ws, spawnStdio);
      else void bridgeCdp(ws, options.devtoolsUrl ?? 'http://127.0.0.1:9222');
    });
  });

  return {
    state,
    listen: (port, host = '0.0.0.0') =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address() as AddressInfo));
      }),
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
