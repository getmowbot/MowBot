import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, ChatgptCredential, Message, Provider } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { providerProfiles } from '../src/db/schema';
import {
  ChatgptService,
  parseInstant,
  planRequestBody,
  streamVerdict,
} from '../src/providers/chatgpt';
import { bearer, createTestApp, setupOwner } from './helpers';

const CLIENT_ID = 'oaiapp_test';
const SUBJECT = 'user-123';
const EMAIL = 'joris@example.com';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
});

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type ResponsesPlay = (body: Record<string, unknown>, call: number) => ServerAnswer;

interface ServerAnswer {
  status?: number;
  json?: unknown;
  events?: Record<string, unknown>[];
}

/** OpenAI's auth server and API, as far as MowBot uses them. */
class FakeOpenAI {
  readonly requests: Recorded[] = [];
  /** Access tokens the API accepts. */
  readonly valid = new Set<string>(['at-0']);
  /** What the token endpoint answers to a refresh (default: rotates both tokens). */
  refreshAnswer: (() => ServerAnswer) | null = null;
  responses: ResponsesPlay = () => ({ events: textEvents('Bonjour !') });
  models: unknown = {
    models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
      { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-6-mini', display_name: 'GPT-6 mini', visibility: 'list' },
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
    ],
  };
  private rotation = 0;
  private responsesCalls = 0;
  private server: http.Server | null = null;
  base = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        this.answer(res, this.route(req, body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }

  of(path: string): Recorded[] {
    return this.requests.filter((r) => r.url.split('?')[0] === path);
  }

  private route(req: http.IncomingMessage, body: string): ServerAnswer {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/.well-known/jwks.json') return { json: { keys: [jwk] } };
    if (path === '/.well-known/openid-configuration') {
      return {
        json: { issuer: this.base, revocation_endpoint: `${this.base}/api/accounts/oauth/revoke` },
      };
    }
    if (path === '/api/accounts/oauth/revoke') return { json: {} };
    if (path === '/api/accounts/oauth/token') {
      if (this.refreshAnswer) return this.refreshAnswer();
      this.rotation += 1;
      const access = `at-${this.rotation}`;
      this.valid.add(access);
      return {
        json: {
          access_token: access,
          refresh_token: `rt-${this.rotation}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        },
      };
    }
    if (path === '/v1/chat/completions') return { events: chatEvents('Depuis le secours') };
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (path.startsWith('/v1/') && !this.valid.has(token)) {
      return { status: 401, json: { detail: 'Unauthorized' } };
    }
    if (path === '/v1/models') return { json: this.models };
    if (path === '/v1/responses') {
      return this.responses(JSON.parse(body) as Record<string, unknown>, this.responsesCalls++);
    }
    return { status: 404, json: {} };
  }

  private answer(res: http.ServerResponse, answer: ServerAnswer) {
    res.statusCode = answer.status ?? 200;
    if (answer.events) {
      res.setHeader('content-type', 'text/event-stream');
      for (const event of answer.events) {
        res.write(
          event.type
            ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            : `data: ${JSON.stringify(event)}\n\n`,
        );
      }
      if (answer.events.some((e) => 'choices' in e)) res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer.json ?? {}));
  }
}

const created = (sequence: number) => ({
  type: 'response.created',
  sequence_number: sequence,
  response: { id: 'resp_1', created_at: 1, model: 'gpt-6.1-sol' },
});

function textEvents(text: string): Record<string, unknown>[] {
  return [
    created(0),
    {
      type: 'response.in_progress',
      sequence_number: 1,
      response: { id: 'resp_1', created_at: 1, model: 'gpt-6.1-sol' },
    },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 3 } } },
  ];
}

function toolEvents(name: string, args: unknown): Record<string, unknown>[] {
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: '' };
  return [
    created(0),
    { type: 'response.output_item.added', output_index: 0, item },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, arguments: JSON.stringify(args), status: 'completed' },
    },
    { type: 'response.completed', response: { usage: { input_tokens: 9, output_tokens: 3 } } },
  ];
}

const limitStream = (code = 'subscription_sharing_usage_limit_exceeded') => [
  created(0),
  {
    type: 'response.failed',
    sequence_number: 1,
    response: { error: { code, message: 'Usage limit reached' } },
  },
];

function chatEvents(text: string): Record<string, unknown>[] {
  const chunk = (delta: object, finish: string | null) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'backup',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [chunk({ role: 'assistant', content: text }, null), chunk({}, 'stop')];
}

let fake: FakeOpenAI | undefined;
let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  await fake?.stop();
  t = undefined;
  fake = undefined;
});

async function idToken(claims: Record<string, unknown> = {}, audience = CLIENT_ID) {
  return new SignJWT({
    sub: SUBJECT,
    email: EMAIL,
    nonce: 'nonce-1',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(fake?.base ?? '')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
}

async function credential(patch: Partial<ChatgptCredential> = {}): Promise<ChatgptCredential> {
  return {
    clientId: CLIENT_ID,
    idToken: await idToken(),
    accessToken: 'at-0',
    refreshToken: 'rt-0',
    expiresIn: 3600,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    nonce: 'nonce-1',
    ...patch,
  };
}

async function start() {
  fake = new FakeOpenAI();
  await fake.start();
  t = await createTestApp({ chatgpt: { authUrl: fake.base, apiUrl: `${fake.base}/v1` } });
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const call = async <T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, raw: res.body, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await call<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const addChatgpt = async (patch: Partial<ChatgptCredential> = {}) =>
    call<Provider>('POST', '/api/v1/providers', {
      name: 'ChatGPT',
      kind: 'openai-chatgpt',
      chatgpt: await credential(patch),
    });
  const ask = async (text: string) => {
    await call('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
    const messages = (await call<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`))
      .body.items;
    return messages.at(-1) as Message;
  };
  const textOf = (message: Message) =>
    message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return { app, services, call, chef, addChatgpt, ask, textOf, fake };
}

const TOKENS = ['at-0', 'rt-0', 'at-1', 'rt-1'];

describe('Sign in with ChatGPT', () => {
  it('gives the desktop app a stable host id, and the client to sign in again with', async () => {
    const { call, addChatgpt } = await start();
    const first = await call<{ hostId: string; agentName: string; clientId: string | null }>(
      'GET',
      '/api/v1/providers/chatgpt/sign-in',
    );
    expect(first.status).toBe(200);
    expect(first.body.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(first.body).toMatchObject({ agentName: 'MowBot', clientId: null, loginHint: null });
    const again = await call('GET', '/api/v1/providers/chatgpt/sign-in');
    expect(again.body).toEqual(first.body);

    const provider = (await addChatgpt()).body;
    const reauth = await call('GET', `/api/v1/providers/chatgpt/sign-in?providerId=${provider.id}`);
    expect(reauth.body).toEqual({
      hostId: first.body.hostId,
      agentName: 'MowBot',
      clientId: CLIENT_ID,
      loginHint: EMAIL,
    });
  });

  it('checks the ID token, seals the tokens and never returns them', async () => {
    const { call, addChatgpt, chef, services } = await start();
    const res = await addChatgpt();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'openai-chatgpt',
      baseUrl: `${fake?.base}/v1`,
      hasApiKey: false,
      // The account's first listed model.
      defaultModel: 'gpt-6.1-sol',
      chatgpt: { email: EMAIL, planType: 'plus', status: 'connected', detail: null },
    });
    const listed = await call('GET', '/api/v1/providers');
    const models = await call('GET', `/api/v1/providers/${res.body.id}/models`);
    for (const raw of [res.raw, listed.raw, models.raw]) {
      for (const token of TOKENS) expect(raw).not.toContain(token);
      expect(raw).not.toContain('eyJ');
    }
    const [row] = await services.db
      .select()
      .from(providerProfiles)
      .where(eq(providerProfiles.id, res.body.id));
    expect(row?.oauthSealed).toMatch(/^v1\./);
    expect(row?.oauthSealed).not.toContain('at-0');
    expect(JSON.stringify(row?.oauthAccount)).not.toContain('at-0');

    const bot = (await call<Bot>('GET', `/api/v1/bots/${chef.id}`)).body;
    expect(bot).toMatchObject({ providerId: res.body.id, model: 'gpt-6.1-sol' });
  });

  it('refuses a sign-in that does not hold', async () => {
    const { call, addChatgpt } = await start();
    expect((await addChatgpt({ nonce: 'another' })).body).toMatchObject({
      type: 'urn:mowbot:problem:chatgpt_invalid_id_token',
    });
    expect((await addChatgpt({ idToken: await idToken({}, 'oaiapp_other') })).body).toMatchObject({
      type: 'urn:mowbot:problem:chatgpt_invalid_id_token',
    });
    expect((await addChatgpt({ scope: 'openid profile email offline_access' })).body).toMatchObject(
      { type: 'urn:mowbot:problem:chatgpt_plan_not_granted' },
    );
    expect((await addChatgpt({ clientId: 'dynamic_agent_client' })).status).toBe(400);
    const withKey = await call('POST', '/api/v1/providers', {
      name: 'ChatGPT',
      kind: 'openai-chatgpt',
      apiKey: 'sk-x',
      chatgpt: await credential(),
    });
    expect(withKey.status).toBe(400);
    const noSignIn = await call('POST', '/api/v1/providers', {
      name: 'ChatGPT',
      kind: 'openai-chatgpt',
    });
    expect(noSignIn.body).toMatchObject({ type: 'urn:mowbot:problem:chatgpt_sign_in_required' });
    const wrongKind = await call('POST', '/api/v1/providers', {
      name: 'OpenAI',
      kind: 'openai',
      apiKey: 'sk-x',
      chatgpt: await credential(),
    });
    expect(wrongKind.status).toBe(400);
    expect((await call<{ items: Provider[] }>('GET', '/api/v1/providers')).body.items).toEqual([]);
  });

  it('lists the models OpenAI shows the account, in its order', async () => {
    const { call, addChatgpt } = await start();
    const provider = (await addChatgpt()).body;
    const models = await call('GET', `/api/v1/providers/${provider.id}/models`);
    expect(models.body).toEqual({
      items: [
        { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
        { id: 'gpt-6-mini', name: 'GPT-6 mini' },
      ],
    });
    const request = fake?.of('/v1/models').at(-1);
    expect(request?.headers.authorization).toBe('Bearer at-0');
  });

  it('renews the access token before it expires and keeps the rotated refresh token', async () => {
    const { call, addChatgpt, services } = await start();
    // 60 s left: inside the renewal margin.
    const provider = (await addChatgpt({ expiresIn: 60 })).body;
    const refreshes = () => fake?.of('/api/accounts/oauth/token') ?? [];
    expect(refreshes()).toHaveLength(1);
    const form = new URLSearchParams(refreshes()[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: 'rt-0',
      resource: 'https://api.openai.com/v1',
    });
    expect(fake?.of('/v1/models').at(-1)?.headers.authorization).toBe('Bearer at-1');

    // Fresh now: no renewal.
    await call('GET', `/api/v1/providers/${provider.id}/models`);
    expect(refreshes()).toHaveLength(1);

    // The API refuses the token: renewed once with the rotated refresh token, then retried.
    fake?.valid.delete('at-1');
    const models = await call('GET', `/api/v1/providers/${provider.id}/models`);
    expect(models.status).toBe(200);
    expect(refreshes()).toHaveLength(2);
    expect(new URLSearchParams(refreshes()[1]?.body).get('refresh_token')).toBe('rt-1');
    expect(fake?.of('/v1/models').at(-1)?.headers.authorization).toBe('Bearer at-2');

    // Saved, not only in memory: another service on the same database has the new tokens.
    const fresh = new ChatgptService(
      services.db,
      services.config.masterKey,
      services.config.chatgpt,
    );
    expect(await fresh.accessToken(provider.id)).toBe('at-2');
  });

  it('needs a new sign-in when OpenAI refuses the renewal, and takes one for the same account', async () => {
    const { call, addChatgpt } = await start();
    const provider = (await addChatgpt()).body;
    fake?.valid.delete('at-0');
    if (fake) fake.refreshAnswer = () => ({ status: 400, json: { error: 'invalid_grant' } });

    const models = await call('GET', `/api/v1/providers/${provider.id}/models`);
    expect(models.status).toBe(409);
    expect(models.body).toMatchObject({ type: 'urn:mowbot:problem:chatgpt_sign_in_required' });
    const listed = (await call<{ items: Provider[] }>('GET', '/api/v1/providers')).body.items;
    expect(listed[0]?.chatgpt).toMatchObject({ status: 'needs_sign_in', detail: 'invalid_grant' });

    // No more renewal attempts with the dropped tokens.
    const attempts = fake?.of('/api/accounts/oauth/token').length;
    await call('GET', `/api/v1/providers/${provider.id}/models`);
    expect(fake?.of('/api/accounts/oauth/token').length).toBe(attempts);

    // Another account cannot take this provider over.
    const other = await call('PATCH', `/api/v1/providers/${provider.id}`, {
      chatgpt: await credential({ idToken: await idToken({ sub: 'someone-else' }) }),
    });
    expect(other.status).toBe(409);

    if (fake) fake.refreshAnswer = null;
    fake?.valid.add('at-9');
    const again = await call<Provider>('PATCH', `/api/v1/providers/${provider.id}`, {
      chatgpt: await credential({ accessToken: 'at-9', refreshToken: 'rt-9' }),
    });
    expect(again.status).toBe(200);
    expect(again.body.chatgpt).toMatchObject({ status: 'connected', detail: null });
    for (const token of ['at-9', 'rt-9']) expect(again.raw).not.toContain(token);
    expect((await call('GET', `/api/v1/providers/${provider.id}/models`)).status).toBe(200);
    expect(fake?.of('/v1/models').at(-1)?.headers.authorization).toBe('Bearer at-9');
  });

  it('revokes the refresh token when the provider is deleted', async () => {
    const { call, addChatgpt } = await start();
    const provider = (await addChatgpt()).body;
    expect((await call('DELETE', `/api/v1/providers/${provider.id}`)).status).toBe(204);
    const revoke = fake?.of('/api/accounts/oauth/revoke');
    expect(revoke).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(revoke?.[0]?.body))).toEqual({
      token: 'rt-0',
      token_type_hint: 'refresh_token',
      client_id: CLIENT_ID,
    });
  });

  it('runs bots through the Responses API: bearer, not stored, streamed, with tool calls', async () => {
    const { addChatgpt, ask, textOf } = await start();
    if (fake) {
      fake.responses = (_body, call) =>
        call === 0
          ? { events: toolEvents('canvas_list', {}) }
          : { events: textEvents('Aucun canevas pour le moment.') };
    }
    await addChatgpt();
    const answer = await ask('Quels canevas ?');
    expect(answer.status).toBe('done');
    expect(textOf(answer)).toBe('Aucun canevas pour le moment.');

    const requests = fake?.of('/v1/responses') ?? [];
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.headers.authorization).toBe('Bearer at-0');
      const body = JSON.parse(request.body) as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true });
      for (const key of ['temperature', 'max_output_tokens', 'previous_response_id', 'user']) {
        expect(body).not.toHaveProperty(key);
      }
      const input = body.input as { role?: string; type?: string }[];
      expect(input.some((item) => item.role === 'system')).toBe(false);
      expect(input[0]?.role).toBe('developer');
      expect(input.some((item) => item.type === 'item_reference')).toBe(false);
    }
    const second = JSON.parse(requests[1]?.body ?? '{}') as { input: Record<string, unknown>[] };
    expect(second.input).toContainEqual(
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'canvas_list' }),
    );
    expect(second.input).toContainEqual(
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    );
  });

  it.each([
    ['refused before streaming (HTTP 429)', 'http'],
    ['failed in the stream', 'stream'],
  ])('moves a bot to its fallback model at the usage limit, %s', async (_label, where) => {
    const { call, addChatgpt, ask, textOf, chef } = await start();
    if (fake) {
      fake.responses = () =>
        where === 'http'
          ? {
              status: 429,
              json: {
                error: {
                  code: 'subscription_sharing_usage_limit_exceeded',
                  message: 'Usage limit reached',
                  param: null,
                },
              },
            }
          : { events: limitStream() };
    }
    const chatgpt = (await addChatgpt()).body;
    const backup = (
      await call<Provider>('POST', '/api/v1/providers', {
        name: 'Backup',
        kind: 'openai-compatible',
        baseUrl: `${fake?.base}/v1`,
        apiKey: 'at-0',
      })
    ).body;
    await call('PATCH', `/api/v1/bots/${chef.id}`, {
      fallbacks: [{ providerId: backup.id, model: 'backup' }],
    });

    const answer = await ask('Bonjour');
    expect(answer.status).toBe('done');
    expect(textOf(answer)).toBe('Depuis le secours');
    // Not retried: the limit is not going away in a few seconds.
    expect(fake?.of('/v1/responses')).toHaveLength(1);
    const listed = (await call<{ items: Provider[] }>('GET', '/api/v1/providers')).body.items;
    expect(listed.find((p) => p.id === chatgpt.id)?.chatgpt).toMatchObject({
      status: 'usage_limited',
      detail: 'subscription_sharing_usage_limit_exceeded',
    });

    // Paused a while: the next run goes straight to the fallback.
    expect(textOf(await ask('Encore'))).toBe('Depuis le secours');
    expect(fake?.of('/v1/responses')).toHaveLength(1);
  });

  it('says clearly why a bot without fallback could not answer', async () => {
    const { addChatgpt, ask } = await start();
    if (fake) fake.responses = () => ({ events: limitStream() });
    await addChatgpt();
    const answer = await ask('Bonjour');
    expect(answer.status).toBe('error');
    expect(answer.error).toContain('chatgpt.com/settings/usage');
  });
});

describe('ChatGPT plan requests', () => {
  it('drop what plan usage refuses and are never stored', () => {
    const body = JSON.parse(
      planRequestBody(
        JSON.stringify({
          model: 'gpt-6.1-sol',
          store: true,
          stream: true,
          temperature: 0.2,
          max_output_tokens: 100,
          previous_response_id: 'resp_0',
          input: [
            { role: 'system', content: 'Tu es le Chef.' },
            { role: 'user', content: [{ type: 'input_text', text: 'Salut' }] },
          ],
          tools: [{ type: 'function', name: 'x' }],
        }),
      ),
    );
    expect(body).toEqual({
      model: 'gpt-6.1-sol',
      store: false,
      stream: true,
      input: [
        { role: 'developer', content: 'Tu es le Chef.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Salut' }] },
      ],
      tools: [{ type: 'function', name: 'x' }],
    });
  });

  it('tell a stream error before any output from a normal start', () => {
    const sse = (events: object[], tail = '') =>
      events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('') + tail;
    expect(streamVerdict(sse([created(0)]))).toBeNull();
    expect(streamVerdict(sse([created(0)], 'data: {"type":"response.fa'))).toBeNull();
    expect(streamVerdict(sse(limitStream()))).toEqual({
      code: 'subscription_sharing_usage_limit_exceeded',
      param: null,
    });
    expect(streamVerdict(sse(textEvents('ok')))).toEqual({ code: null, param: null });
  });

  it('read earliest_refresh_at in its usual forms', () => {
    const now = 1_800_000_000_000;
    expect(parseInstant(undefined, now)).toBeNull();
    expect(parseInstant(1_800_000_600, now)).toBe(1_800_000_600_000);
    expect(parseInstant(1_800_000_600_000, now)).toBe(1_800_000_600_000);
    expect(parseInstant(600, now)).toBe(now + 600_000);
    expect(parseInstant('2027-01-15T08:00:00Z', now)).toBe(Date.parse('2027-01-15T08:00:00Z'));
    expect(parseInstant('soon', now)).toBeNull();
  });
});
