import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Agent, createAgent } from '@mowbot/agent';
import type { GpuList, TokenResponse } from '@mowbot/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import {
  type AgentEndpoint,
  type ComputerRuntime,
  type ComputerSpec,
  setupKey,
} from '../src/computers/runtime';
import { type Config, loadConfig } from '../src/config';
import { type Database, openDatabase } from '../src/db/client';
import { createServices, type ServiceOverrides, type Services } from '../src/services';

export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const PASSWORD = 'correct horse battery staple';

/** 1×1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  close(): Promise<void>;
}

type ShellAnswer = { exitCode?: number; stdout?: string; stderr?: string };
type Awaitable<T> = T | Promise<T>;

/**
 * Stands in for Docker: each "container" is a real mow-agent listening on localhost, wired
 * to a fake VNC server that echoes bytes back (none for the MCP computer, which has no desktop).
 */
export class FakeRuntime implements ComputerRuntime {
  readonly machines = new Map<
    string,
    {
      agent: Agent;
      vnc: net.Server | null;
      port: number;
      running: boolean;
      workspaceId: string;
      kind: ComputerSpec['kind'];
      system: ComputerSpec['system'];
      gpus: ComputerSpec['gpus'];
    }
  >();
  failNextStart: Error | null = null;
  /** The host's graphics cards, as Docker would list them. */
  gpuList: GpuList = { available: false, items: [] };
  /** Shell commands the computers ran, in order. */
  readonly commands: string[] = [];
  /** The same, with the kind of computer each ran on. */
  readonly ran: { kind: ComputerSpec['kind']; command: string }[] = [];
  /** Answers each shell command with the command itself (to see what reached the computer). */
  echoCommands = false;
  /** Answers the shell commands it recognises (the others get an empty success), maybe later. */
  shell: ((script: string) => Awaitable<ShellAnswer | undefined>) | null = null;
  /** Starts the process behind /stdio (an MCP server), when a test needs one. */
  stdio:
    | ((
        command: string,
        env: Record<string, string>,
        kind: ComputerSpec['kind'],
      ) => ChildProcessWithoutNullStreams)
    | null = null;

  async start(spec: ComputerSpec): Promise<{ containerId: string; setup: string }> {
    if (this.failNextStart) {
      const error = this.failNextStart;
      this.failNextStart = null;
      throw error;
    }
    const containerId = `fake-${spec.id}`;
    const running = this.machines.get(containerId);
    if (running?.running) return { containerId, setup: setupKey(running) };
    // No screen on the MCP computer, nor on a PC without its desktop.
    const screen = spec.kind !== 'mcp' && spec.system === 'desktop';
    const vnc = screen ? net.createServer((socket) => socket.pipe(socket)) : null;
    if (vnc) await new Promise<void>((resolve) => vnc.listen(0, '127.0.0.1', resolve));
    const agent = createAgent({
      token: spec.agentToken,
      // Nothing listens there for the MCP computer.
      vncPort: vnc ? (vnc.address() as net.AddressInfo).port : 9,
      spawnStdio: (command, env) => {
        if (!this.stdio) throw new Error('No stdio process in this test');
        return this.stdio(command, env, spec.kind);
      },
      run: async (command, args) => {
        // scrot writes its PNG to the path given last.
        if (command === 'scrot') await writeFile(args.at(-1) as string, TINY_PNG);
        const script = command === 'bash' ? (args.at(-1) ?? '') : '';
        if (script) {
          this.commands.push(script);
          this.ran.push({ kind: spec.kind, command: script });
        }
        const scripted = script ? await this.shell?.(script) : undefined;
        if (scripted) {
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...scripted };
        }
        const stdout = this.echoCommands ? script : '';
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      },
    });
    const { port } = await agent.listen(0, '127.0.0.1');
    this.machines.set(containerId, {
      agent,
      vnc,
      port,
      running: true,
      workspaceId: spec.workspaceId,
      kind: spec.kind,
      system: spec.system,
      gpus: spec.gpus,
    });
    return { containerId, setup: setupKey(spec) };
  }

  async stop(containerId: string): Promise<void> {
    const machine = this.machines.get(containerId);
    if (!machine?.running) return;
    machine.running = false;
    await machine.agent.close();
    const { vnc } = machine;
    if (vnc) await new Promise((resolve) => vnc.close(resolve));
  }

  async remove(computerId: string): Promise<void> {
    const containerId = `fake-${computerId}`;
    await this.stop(containerId);
    this.machines.delete(containerId);
  }

  async isRunning(containerId: string): Promise<boolean | null> {
    const machine = this.machines.get(containerId);
    return machine ? machine.running : null;
  }

  async agentEndpoint(containerId: string): Promise<AgentEndpoint> {
    const machine = this.machines.get(containerId);
    if (!machine) throw new Error('no such container');
    return { host: '127.0.0.1', port: machine.port };
  }

  async gpus(): Promise<GpuList> {
    return this.gpuList;
  }

  async stopAll(): Promise<void> {
    for (const id of this.machines.keys()) await this.stop(id);
  }
}

/** A hub backed by an in-memory PGlite database, a temp workspaces dir and a fake runtime. */
export async function createTestApp(
  overrides: Partial<Config> = {},
  runtime = new FakeRuntime(),
  modelFor?: ServiceOverrides['modelFor'],
  extra: Pick<
    ServiceOverrides,
    | 'askTimeoutMs'
    | 'pushFetch'
    | 'finishedPushAfterMs'
    | 'transcriber'
    | 'previewClock'
    | 'webFetch'
  > = {},
): Promise<TestApp & { runtime: FakeRuntime; workspacesDir: string }> {
  const workspacesDir = await mkdtemp(path.join(tmpdir(), 'mowbot-ws-'));
  const config: Config = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      MOWBOT_MASTER_KEY: randomBytes(32).toString('base64'),
      MOWBOT_SETUP_TOKEN: SETUP_TOKEN,
      MOWBOT_WORKSPACES_DIR: workspacesDir,
    }),
    ...overrides,
  };
  const database: Database = await openDatabase(config.databaseUrl);
  await database.migrate();
  const services = await createServices(config, database.db, {
    runtime,
    modelFor,
    // Never Whisper in tests: no model download.
    transcriber: { transcribe: () => Promise.reject(new Error('No transcriber in this test')) },
    ...extra,
  });
  const app = await buildApp(services);
  await app.ready();
  return {
    app,
    services,
    runtime,
    workspacesDir,
    close: async () => {
      await app.close();
      await runtime.stopAll();
      await database.close();
      await rm(workspacesDir, { recursive: true, force: true });
    },
  };
}

export async function setupOwner(
  app: FastifyInstance,
  device: { name: string; kind: 'web' | 'ios' | 'cli' } = { name: 'CLI', kind: 'cli' },
): Promise<TokenResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { setupToken: SETUP_TOKEN, displayName: 'Joris', password: PASSWORD, device },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** multipart/form-data with fields first, then files (each with its own field name and type). */
export function multipartForm(
  fields: Record<string, string>,
  files: { name: string; content: string | Buffer; type?: string; field?: string }[],
) {
  const boundary = `----mowbot${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Minimal multipart/form-data body with one `file` part per entry. */
export function multipart(files: { name: string; content: string | Buffer }[]) {
  const boundary = `----mowbot${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
