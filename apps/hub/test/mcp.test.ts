import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { McpServer as SdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Bot,
  Computer,
  McpCall,
  McpComputer,
  McpServer,
  Message,
  ServerEvent,
  Team,
} from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clipResult } from '../src/agents/mcp-tools';
import { bots, mcpServers } from '../src/db/schema';
import { bearer, createTestApp, type FakeRuntime, setupOwner, TINY_PNG } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;
const servers: http.Server[] = [];

afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A remote MCP server (Streamable HTTP, stateless), optionally behind a bearer token. */
async function calculator(options: { token?: string; oauth?: boolean } = {}) {
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // A minimal OAuth authorization server, for the sign-in test.
    if (options.oauth) {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.pathname === '/register') {
        let body = '';
        for await (const chunk of req) body += chunk;
        return json(201, { ...JSON.parse(body), client_id: 'mowbot-client' });
      }
      if (url.pathname === '/token') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        if (form.get('code') !== 'c0de' || !form.get('code_verifier'))
          return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'good-token', token_type: 'Bearer', expires_in: 3600 });
      }
    }
    const token = options.token ?? (options.oauth ? 'good-token' : undefined);
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
      return res.end();
    }
    const mcp = new SdkServer({ name: 'calc', version: '1.0.0' });
    mcp.registerTool(
      'add',
      { description: 'Adds two numbers', inputSchema: { a: z.number(), b: z.number() } },
      async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
    );
    mcp.registerTool('picture', { description: 'Draws a picture', inputSchema: {} }, async () => ({
      content: [{ type: 'image', data: TINY_PNG.toString('base64'), mimeType: 'image/png' }],
    }));
    mcp.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'quota exceeded' }],
      isError: true,
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    let body = '';
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function start(model?: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, model ? () => model : undefined);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = auth,
  ) => {
    const res = await app.inject({ method, url, headers, payload: payload as object });
    const json = res.headers['content-type']?.toString().includes('json');
    return { status: res.statusCode, text: res.body, body: (json ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const say = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const transcript = async () =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
  return { inject, chef, say, transcript, services, runtime, app };
}

const toolsSeen = (model: MockLanguageModelV4, call: number) =>
  (model.doStreamCalls[call]?.tools ?? []).map((tool) => tool.name);

describe('remote MCP servers', () => {
  it('lists their tools, and bots call them as their own', async () => {
    const url = await calculator({ token: 's3cret' });
    const model = scripted([
      toolTurn('mcp__calc__add', { a: 2, b: 3 }),
      toolTurn('mcp__calc__picture', {}, 'call-2'),
      toolTurn('mcp__calc__fail', {}, 'call-3'),
      textTurn('2 + 3 = 5.'),
    ]);
    const { inject, say, transcript, services } = await start(model);
    const created = await inject<McpServer>('POST', '/api/v1/mcp/servers', {
      name: 'Calc',
      transport: 'http',
      url,
      secrets: { Authorization: 'Bearer s3cret' },
    });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain('s3cret');
    const refreshed = await inject<McpServer>(
      'POST',
      `/api/v1/mcp/servers/${created.body.id}/refresh`,
    );
    expect(refreshed.body).toMatchObject({
      status: 'ok',
      slug: 'calc',
      secretKeys: ['Authorization'],
      tools: [{ name: 'add' }, { name: 'picture' }, { name: 'fail' }],
    });

    await say('Combien font 2 + 3 ?');
    expect(toolsSeen(model, 0)).toContain('mcp__calc__add');
    const parts = (await transcript()).flatMap((m) => m.parts);
    expect(parts.find((p) => p.type === 'tool' && p.toolName === 'mcp__calc__add')).toMatchObject({
      state: 'done',
      output: '5',
    });
    // The picture reached the model at its next step; the failure came back as an error.
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain('image/png');
    expect(parts.find((p) => p.type === 'tool' && p.toolName === 'mcp__calc__fail')).toMatchObject({
      state: 'error',
      output: 'quota exceeded',
    });
    const calls = await inject<{ items: McpCall[] }>(
      'GET',
      `/api/v1/mcp/servers/${created.body.id}/calls`,
    );
    expect(calls.body.items.map((c) => [c.tool, c.ok])).toEqual([
      ['fail', false],
      ['picture', true],
      ['add', true],
    ]);
    await services.mcp.close();
  });

  it('gives tools only to the bots in scope, and marks a server it cannot reach', async () => {
    const url = await calculator();
    const model = scripted([textTurn('Ok.')]);
    const { inject, say, chef } = await start(model);
    const created = await inject<McpServer>('POST', '/api/v1/mcp/servers', {
      name: 'Calc',
      transport: 'http',
      url,
      scope: { kind: 'bots', ids: ['00000000-0000-4000-8000-000000000000'] },
    });
    await inject('POST', `/api/v1/mcp/servers/${created.body.id}/refresh`);
    await say('Bonjour');
    expect(toolsSeen(model, 0).some((name) => name.startsWith('mcp__'))).toBe(false);

    await inject('PATCH', `/api/v1/mcp/servers/${created.body.id}`, {
      scope: { kind: 'bots', ids: [chef.id] },
    });
    await say('Et maintenant ?');
    expect(toolsSeen(model, 1)).toContain('mcp__calc__add');

    const broken = await inject<McpServer>('POST', '/api/v1/mcp/servers', {
      name: 'Nowhere',
      transport: 'http',
      url: 'http://127.0.0.1:9/mcp',
    });
    const refresh = await inject('POST', `/api/v1/mcp/servers/${broken.body.id}/refresh`);
    expect(refresh.status).toBe(502);
    const list = await inject<{ items: McpServer[] }>('GET', '/api/v1/mcp/servers');
    expect(list.body.items.find((s) => s.id === broken.body.id)?.status).toBe('error');
  });

  it('signs in with OAuth through the browser', async () => {
    const url = await calculator({ oauth: true });
    const { inject } = await start();
    const created = await inject<McpServer>('POST', '/api/v1/mcp/servers', {
      name: 'Agenda',
      transport: 'http',
      url,
      auth: 'oauth',
    });
    const started = await inject<{ authorizationUrl: string }>(
      'POST',
      `/api/v1/mcp/servers/${created.body.id}/oauth/start`,
      { redirectBase: 'http://mowbot.test' },
    );
    const authorize = new URL(started.body.authorizationUrl);
    expect(authorize.pathname).toBe('/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'http://mowbot.test/api/v1/mcp/oauth/callback',
    );
    const state = authorize.searchParams.get('state');

    // The authorization server sends the browser back (no bearer token: a public page).
    const back = await inject(
      'GET',
      `/api/v1/mcp/oauth/callback?code=c0de&state=${state}`,
      undefined,
      {},
    );
    expect(back.status).toBe(200);
    expect(back.text).toContain('Connecté à Agenda');
    const list = await inject<{ items: McpServer[] }>('GET', '/api/v1/mcp/servers');
    expect(list.body.items[0]).toMatchObject({ status: 'ok', tools: [{ name: 'add' }, {}, {}] });
    const wrong = await inject(
      'GET',
      '/api/v1/mcp/oauth/callback?code=c0de&state=nope',
      undefined,
      {},
    );
    expect(wrong.status).toBe(400);
  });
});

const fixture = path.join(__dirname, 'fixtures', 'mcp-stdio.mjs');

/** Runs the stdio fixture wherever the hub starts a local server, noting where. */
function runNotes(runtime: FakeRuntime) {
  const started: { command: string; kind: string }[] = [];
  runtime.stdio = (command, env, kind) => {
    started.push({ command, kind });
    return spawn(process.execPath, [fixture], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  return started;
}

/** What each call of the tool returned (as the app shows it). */
const outputsOf = (messages: Message[], toolName: string) =>
  messages
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === 'tool' && p.toolName === toolName ? [p.output ?? ''] : []));

describe('local MCP servers', () => {
  it('run on the MCP computer, for the bots in scope', async () => {
    const model = scripted([
      toolTurn('mcp__notes__echo', { text: 'hello' }),
      toolTurn('mcp__notes__playlist', { count: 5_000 }, 'call-2'),
      toolTurn('mcp__notes__whoami', {}, 'call-3'),
      textTurn('Fait.'),
    ]);
    const { inject, say, transcript, runtime, services, chef } = await start(model);
    const started = runNotes(runtime);
    const seen: ServerEvent[] = [];
    services.events.subscribe((event) => seen.push(event));
    const asleep = await inject<McpComputer>('GET', '/api/v1/mcp/computer');
    expect(asleep.body).toMatchObject({ id: null, status: 'stopped' });

    const created = await inject<McpServer>('POST', '/api/v1/mcp/servers', {
      name: 'Notes',
      transport: 'stdio',
      command: 'notes-mcp',
      secrets: { GREETING: 'Salut', API_TOKEN: 'tok-123456' },
    });
    expect(created.body.computerId).toBeNull();
    const refreshed = await inject<McpServer>(
      'POST',
      `/api/v1/mcp/servers/${created.body.id}/refresh`,
    );
    expect(refreshed.body).toMatchObject({
      status: 'ok',
      tools: [{ name: 'echo' }, { name: 'playlist' }, { name: 'whoami' }],
    });
    // Started on the MCP computer (which has no desktop), not on a bot's.
    expect(started[0]).toEqual({ command: 'notes-mcp', kind: 'mcp' });
    const pc = (await inject<McpComputer>('GET', '/api/v1/mcp/computer')).body;
    expect(pc.status).toBe('running');
    const pcs = await inject<{ items: Computer[] }>('GET', '/api/v1/computers');
    expect(pcs.body.items.map((c) => c.id)).not.toContain(pc.id);
    expect(seen.some((e) => e.type === 'mcp.computer' && e.computer.status === 'running')).toBe(
      true,
    );
    expect(seen.some((e) => e.type === 'computer.updated' && e.computer.id === pc.id)).toBe(false);

    await say('Joue avec les notes');
    const messages = await transcript();
    expect(outputsOf(messages, 'mcp__notes__echo')).toEqual(['Salut: hello']);
    // A long result keeps its beginning, and says it was cut.
    const seenByModel = promptOf(model, 2);
    expect(seenByModel).toContain('Track 1: a rather long title\\nTrack 2:');
    expect(seenByModel).toContain('Résultat coupé');
    expect(seenByModel).not.toContain('Track 5000:');
    // What a server says never shows its secrets.
    expect(outputsOf(messages, 'mcp__notes__whoami')).toEqual(['token=••••']);
    expect(JSON.stringify(model.doStreamCalls.map((c) => c.prompt))).not.toContain('tok-123456');

    // Any bot in scope gets it, with or without a computer of its own.
    const [row] = await services.db.select().from(bots).where(eq(bots.id, chef.id));
    if (!row) throw new Error('no Chef');
    const without = await services.mcp.accessibleTo({ ...row, computerId: null });
    expect(without.map((s) => s.slug)).toEqual(['notes']);
    await services.mcp.stopComputer();
    expect((await inject<McpComputer>('GET', '/api/v1/mcp/computer')).body.status).toBe('stopped');
    await services.mcp.close();
  });

  it('are managed by the Chef: set up on the MCP computer, added, changed, removed', async () => {
    const model = scripted([
      toolTurn('mcp_setup', { command: 'pipx install notes-mcp' }),
      toolTurn(
        'mcp_add',
        {
          name: 'Notes',
          command: 'notes-mcp',
          env: { GREETING: 'Salut', API_TOKEN: 'tok-123456' },
          scope: { kind: 'teams', names: ['Équipe principale'] },
        },
        'call-2',
      ),
      toolTurn('mcp_call', { server: 'notes', tool: 'echo', arguments: { text: 'hi' } }, 'call-3'),
      toolTurn('mcp_setup', { command: 'cat ~/.config/notes.env' }, 'call-4'),
      toolTurn('mcp_list', {}, 'call-5'),
      toolTurn('mcp_update', { server: 'notes', enabled: false }, 'call-6'),
      toolTurn('mcp_remove', { server: 'Notes' }, 'call-7'),
      textTurn('Fait.'),
    ]);
    const { inject, say, transcript, runtime, services } = await start(model);
    const started = runNotes(runtime);
    runtime.shell = (script) => {
      if (script.includes('pipx install')) return { stdout: 'installed package notes-mcp 1.0\n' };
      if (script.includes('notes.env')) return { stdout: 'API_TOKEN=tok-123456\n' };
      return undefined;
    };
    await say('Branche-nous le serveur de notes');

    const tools = toolsSeen(model, 0);
    expect(tools).toEqual(
      expect.arrayContaining(['mcp_list', 'mcp_add', 'mcp_update', 'mcp_remove', 'mcp_setup']),
    );
    expect(tools).not.toContain('mcp_add_local');
    expect(promptOf(model, 0)).toContain('## Les serveurs MCP');
    expect(promptOf(model, 0)).toContain('jamais leur code');
    // The setup commands and the server ran on the MCP computer.
    expect(runtime.ran.filter((r) => r.command.includes('notes'))).toEqual([
      { kind: 'mcp', command: 'pipx install notes-mcp' },
      { kind: 'mcp', command: 'cat ~/.config/notes.env' },
    ]);
    expect(started.map((s) => s.kind)).toEqual(['mcp']);

    const messages = await transcript();
    expect(outputsOf(messages, 'mcp_setup')).toEqual([
      expect.stringContaining('installed package notes-mcp'),
      expect.stringContaining('API_TOKEN=••••'),
    ]);
    expect(outputsOf(messages, 'mcp_add')[0]).toContain('3 outils');
    expect(outputsOf(messages, 'mcp_call')).toEqual(['Salut: hi']);
    const [list] = outputsOf(messages, 'mcp_list');
    expect(list).toContain('PC MCP : allumé');
    expect(list).toContain(
      'Notes (notes) · local, PC MCP · OK · 3 outils · équipes : Équipe principale',
    );
    expect(list).toContain('variables secrets : GREETING, API_TOKEN');
    expect(outputsOf(messages, 'mcp_update')[0]).toContain('désactivé');
    expect(outputsOf(messages, 'mcp_remove')[0]).toContain('retiré');
    // Secrets never come back in what the tools return.
    for (const name of ['mcp_setup', 'mcp_add', 'mcp_list', 'mcp_update', 'mcp_call']) {
      for (const output of outputsOf(messages, name)) expect(output).not.toContain('tok-123456');
    }
    const left = await inject<{ items: McpServer[] }>('GET', '/api/v1/mcp/servers');
    expect(left.body.items).toEqual([]);
    await services.mcp.close();
  });

  it('installed by a bot on its own computer stay there until moved', async () => {
    const model = scripted([textTurn('Ok.')]);
    const { inject, chef, services, runtime } = await start(model);
    const started = runNotes(runtime);
    const team = (await inject<{ items: Team[] }>('GET', '/api/v1/teams')).body.items[0] as Team;
    const lea = (
      await inject<Bot>('POST', '/api/v1/bots', {
        name: 'Léa',
        role: 'Recherche',
        teamId: team.id,
        computer: 'dedicated',
      })
    ).body;
    const botRow = async (id: string) => {
      const [row] = await services.db.select().from(bots).where(eq(bots.id, id));
      if (!row) throw new Error('no bot');
      return row;
    };
    const slugsFor = async (id: string) =>
      (await services.mcp.accessibleTo(await botRow(id))).map((s) => s.slug);
    // As `mcp_add_local` left it: on the Chef's (team) computer, for the bots of that computer.
    const legacy = await services.mcp.create(
      {
        name: 'Notes',
        transport: 'stdio',
        command: 'notes-mcp',
        auth: 'none',
        scope: { kind: 'all', ids: [] },
      },
      { botId: chef.id },
    );
    await services.db
      .update(mcpServers)
      .set({ computerId: chef.computerId })
      .where(eq(mcpServers.id, legacy.id));
    expect(await slugsFor(chef.id)).toEqual(['notes']);
    expect(await slugsFor(lea.id)).toEqual([]);
    await inject('POST', `/api/v1/mcp/servers/${legacy.id}/refresh`);
    expect(started.at(-1)?.kind).toBe('team');

    const moved = await inject<McpServer>('POST', `/api/v1/mcp/servers/${legacy.id}/move`);
    expect(moved.status).toBe(200);
    // The bots that had it keep it: "all" meant the team computer's bots, now its team.
    expect(moved.body).toMatchObject({
      computerId: null,
      scope: { kind: 'teams', ids: [team.id] },
    });
    await services.mcp.refresh(legacy.id);
    expect(started.at(-1)?.kind).toBe('mcp');
    expect(await slugsFor(lea.id)).toEqual(['notes']);
    expect((await inject('POST', `/api/v1/mcp/servers/${legacy.id}/move`)).status).toBe(409);

    // Other bots use the servers, and ask the Chef for new ones.
    await inject('POST', `/api/v1/bots/${lea.id}/messages`, { text: 'Salut' });
    await services.runtime.settle();
    const tools = toolsSeen(model, 0);
    expect(tools).toContain('mcp__notes__echo');
    expect(tools.filter((name) => /^mcp_(add|update|remove|setup|list)/.test(name))).toEqual([]);
    expect(promptOf(model, 0)).toContain('demande-le au Chef');
    await services.mcp.close();
  });
});

describe('clipResult', () => {
  it('keeps the beginning of a long result, cut at a line', () => {
    expect(clipResult('short')).toBe('short');
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const cut = clipResult(long, 100);
    expect(cut.startsWith('line 0\nline 1\n')).toBe(true);
    expect(cut.split('\n\n')[0]?.endsWith('line 12')).toBe(true);
    expect(cut).toContain(`sur ${long.length}`);
  });
});
