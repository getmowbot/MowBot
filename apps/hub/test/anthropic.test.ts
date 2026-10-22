import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Bot, Message, Provider } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, setupOwner } from './helpers';

const KEY = 'sk-ant-api03-test-key';

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

/** Stands in for Anthropic's API: the Models API and a streamed Messages answer. */
class FakeAnthropic {
  readonly seen: Seen[] = [];
  private server: http.Server | null = null;
  base = '';

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        this.seen.push({
          method: req.method ?? '',
          path,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
        });
        if (req.headers['x-api-key'] !== KEY) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error' } }));
          return;
        }
        if (req.method === 'GET' && path === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              data: [
                model('claude-opus-5-5', 'Claude Opus 5.5'),
                model('claude-haiku-5-5', 'Claude Haiku 5.5'),
              ],
              has_more: false,
              first_id: 'claude-opus-5-5',
              last_id: 'claude-haiku-5-5',
            }),
          );
          return;
        }
        if (req.method === 'POST' && path === '/v1/messages') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const [event, data] of answer('Bonjour, je suis prêt.')) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          res.end();
          return;
        }
        res.writeHead(404).end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  of(path: string): Seen[] {
    return this.seen.filter((request) => request.path === path);
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

const model = (id: string, display_name: string) => ({
  type: 'model',
  id,
  display_name,
  created_at: '2026-10-01T00:00:00Z',
});

/** The events of a streamed text answer, as the Messages API sends them. */
function answer(text: string): [string, unknown][] {
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 1000 },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 8 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
}

let fake: FakeAnthropic | null = null;
let t: Awaited<ReturnType<typeof createTestApp>> | null = null;

afterEach(async () => {
  await t?.close();
  t = null;
  await fake?.close();
  fake = null;
});

async function start() {
  fake = new FakeAnthropic();
  await fake.start();
  t = await createTestApp();
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const call = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T, raw: res.body };
  };
  const chef = (await call<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  return { call, chef, services };
}

describe('Anthropic with an API key', () => {
  it('needs a key, keeps it sealed, lists Claude models and starts bots on the current Opus', async () => {
    const { call, chef } = await start();
    const base = `${fake?.base}/v1`;
    const keyless = await call('POST', '/api/v1/providers', {
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: base,
    });
    expect(keyless.status).toBe(400);
    expect(keyless.body).toMatchObject({ type: 'urn:mowbot:problem:api_key_required' });

    const created = await call<Provider>('POST', '/api/v1/providers', {
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: base,
      apiKey: KEY,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'anthropic',
      baseUrl: base,
      hasApiKey: true,
      defaultModel: 'claude-opus-5-5',
    });
    expect(created.raw).not.toContain(KEY);
    // The first provider goes to the Chef, with its default model.
    const bot = (await call<Bot>('GET', `/api/v1/bots/${chef.id}`)).body;
    expect(bot).toMatchObject({ providerId: created.body.id, model: 'claude-opus-5-5' });

    const models = await call<{ items: { id: string; name?: string }[] }>(
      'GET',
      `/api/v1/providers/${created.body.id}/models`,
    );
    expect(models.status).toBe(200);
    // Newest first, as Anthropic lists them, with their names.
    expect(models.body.items).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ]);
    expect(models.raw).not.toContain(KEY);
    expect(fake?.of('/v1/models')[0]?.headers['x-api-key']).toBe(KEY);
  });

  it('runs bots through the Messages API, streamed and cached', async () => {
    const { call, chef, services } = await start();
    await call<Provider>('POST', '/api/v1/providers', {
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: `${fake?.base}/v1`,
      apiKey: KEY,
    });
    await call('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Bonjour' });
    await services.runtime.settle();

    const answered = (
      await call<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)
    ).body.items.at(-1);
    expect(answered).toMatchObject({ role: 'assistant', status: 'done' });
    expect(answered?.parts).toContainEqual({ type: 'text', text: 'Bonjour, je suis prêt.' });

    const [request] = fake?.of('/v1/messages') ?? [];
    expect(request?.headers['x-api-key']).toBe(KEY);
    expect(request?.headers['anthropic-version']).toBeTruthy();
    expect(request?.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      // The whole prefix (tools, system prompt, conversation) is cached at each step.
      cache_control: { type: 'ephemeral' },
    });
    expect(Array.isArray(request?.body?.tools)).toBe(true);
    // Not Anthropic's own API: no server-side fallback asked of a proxy.
    expect(request?.body).not.toHaveProperty('fallbacks');
    expect(request?.body).not.toHaveProperty('temperature');
  });
});
