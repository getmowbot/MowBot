import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { McpServer as SdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Bot, McpCall, McpServer, Message } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bearer, createTestApp, setupOwner, TINY_PNG } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

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

describe('local MCP servers', () => {
  it('run on the bot’s computer, installed by the bot itself', async () => {
    const model = scripted([
      toolTurn('mcp_add_local', {
        name: 'Notes',
        command: 'node notes.mjs',
        env: { GREETING: 'Salut' },
      }),
      toolTurn(
        'mcp_call',
        { server: 'notes', tool: 'echo', arguments: { text: 'hello' } },
        'call-2',
      ),
      textTurn('Installé.'),
      textTurn('Ok.'),
    ]);
    const { say, transcript, runtime, services } = await start(model);
    const fixture = path.join(__dirname, 'fixtures', 'mcp-stdio.mjs');
    const started: string[] = [];
    runtime.stdio = (command, env) => {
      started.push(command);
      return spawn(process.execPath, [fixture], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    };
    await say('Installe-toi un serveur de notes');
    expect(started).toEqual(['node notes.mjs']);
    const parts = (await transcript()).flatMap((m) => m.parts);
    expect(parts.find((p) => p.type === 'tool' && p.toolName === 'mcp_add_local')).toMatchObject({
      state: 'done',
    });
    expect(parts.find((p) => p.type === 'tool' && p.toolName === 'mcp_call')).toMatchObject({
      output: 'Salut: hello',
    });
    // Next turn, its tools are the bot's own.
    await say('Encore');
    await vi.waitFor(() => expect(toolsSeen(model, 3)).toContain('mcp__notes__echo'));
    await services.mcp.close();
  });
});
