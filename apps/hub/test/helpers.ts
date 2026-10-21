import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Agent, createAgent } from '@mowbot/agent';
import type { TokenResponse } from '@mowbot/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { AgentEndpoint, ComputerRuntime, ComputerSpec } from '../src/computers/runtime';
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

/**
 * Stands in for Docker: each "container" is a real mow-agent listening on localhost, wired
 * to a fake VNC server that echoes bytes back.
 */
export class FakeRuntime implements ComputerRuntime {
  readonly machines = new Map<
    string,
    { agent: Agent; vnc: net.Server; port: number; running: boolean; workspaceId: string }
  >();
  failNextStart: Error | null = null;
  /** Shell commands the computers ran, in order. */
  readonly commands: string[] = [];
  /** Answers each shell command with the command itself (to see what reached the computer). */
  echoCommands = false;

  async start(spec: ComputerSpec): Promise<{ containerId: string }> {
    if (this.failNextStart) {
      const error = this.failNextStart;
      this.failNextStart = null;
      throw error;
    }
    const containerId = `fake-${spec.id}`;
    if (this.machines.get(containerId)?.running) return { containerId };
    const vnc = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => vnc.listen(0, '127.0.0.1', resolve));
    const agent = createAgent({
      token: spec.agentToken,
      vncPort: (vnc.address() as net.AddressInfo).port,
      run: async (command, args) => {
        // scrot writes its PNG to the path given last.
        if (command === 'scrot') await writeFile(args.at(-1) as string, TINY_PNG);
        const script = command === 'bash' ? (args.at(-1) ?? '') : '';
        if (script) this.commands.push(script);
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
    });
    return { containerId };
  }

  async stop(containerId: string): Promise<void> {
    const machine = this.machines.get(containerId);
    if (!machine?.running) return;
    machine.running = false;
    await machine.agent.close();
    await new Promise((resolve) => machine.vnc.close(resolve));
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

  async stopAll(): Promise<void> {
    for (const id of this.machines.keys()) await this.stop(id);
  }
}

/** A hub backed by an in-memory PGlite database, a temp workspaces dir and a fake runtime. */
export async function createTestApp(
  overrides: Partial<Config> = {},
  runtime = new FakeRuntime(),
  modelFor?: ServiceOverrides['modelFor'],
  extra: Pick<ServiceOverrides, 'askTimeoutMs' | 'pushFetch' | 'finishedPushAfterMs'> = {},
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
  const services = await createServices(config, database.db, { runtime, modelFor, ...extra });
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
