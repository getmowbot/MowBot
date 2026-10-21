import http from 'node:http';
import type net from 'node:net';
import type { Preview, ServerEvent, Team } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { HttpProblem } from '../src/http/problems';
import { TOKEN_PARAM } from '../src/previews/proxy';
import { bearer, createTestApp, PASSWORD, setupOwner } from './helpers';

/** A range of our own for each run (test files run in parallel). */
const FIRST = 21_000 + Math.floor(Math.random() * 2_000) * 10;
const DAY = 24 * 60 * 60 * 1000;

let t: Awaited<ReturnType<typeof createTestApp>>;
let token: string;
let team: Team;
let computerId: string;
let offset = 0;
let model: MockLanguageModelV4 | null = null;
let events: ServerEvent[];

/** What the bot's dev server received. */
let seen: { url: string; headers: http.IncomingHttpHeaders }[];
let upgrades: http.IncomingHttpHeaders[];
let dev: http.Server;
let devPort: number;

beforeEach(async () => {
  offset = 0;
  model = null;
  t = await createTestApp(
    {
      host: '127.0.0.1',
      previews: { ports: { first: FIRST, last: FIRST + 2 }, publicUrl: undefined, ttlMs: DAY },
    },
    undefined,
    () => model,
    { previewClock: () => Date.now() + offset },
  );
  token = (await setupOwner(t.app)).accessToken;
  team = (
    await t.app.inject({ method: 'GET', url: '/api/v1/teams', headers: bearer(token) })
  ).json().items[0];
  computerId = team.computerId as string;
  events = [];
  t.services.events.subscribe((event) => events.push(event));

  seen = [];
  upgrades = [];
  // The bot's dev server, on the PC's loopback (the fake PC's agent relays to this machine's).
  dev = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    if (req.url === '/cookies') {
      res.setHeader('set-cookie', [
        'mowbot_refresh=evil; Path=/api/v1/auth; HttpOnly',
        '__Host-mowbot_x=1; Path=/; Secure',
        '=mowbot_refresh=nameless; Path=/',
        'theme=light; Domain=example.com; Path=/; HttpOnly',
      ]);
      res.setHeader('clear-site-data', '"cookies"');
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
      res.end('cookies');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${devPort}/after?x=1` });
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ server: dev, path: '/hmr' });
  wss.on('connection', (socket, req) => {
    upgrades.push(req.headers);
    socket.on('message', (data) => socket.send(`echo ${String(data)}`));
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  devPort = (dev.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await t.close();
  dev.closeAllConnections();
  await new Promise((resolve) => dev.close(resolve));
});

async function startPc() {
  await t.app.inject({
    method: 'POST',
    url: `/api/v1/computers/${computerId}/start`,
    headers: bearer(token),
  });
  await t.services.computers.waitForBoot(computerId);
}

async function share(port = devPort, path = '/') {
  await startPc();
  return t.services.previews.share({ computerId, botId: null, port, title: 'Site', path });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A raw request to a preview port (headers exactly as given, no cookie jar, no redirects). */
function request(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

const cookieOf = (publicPort: number, secret: string) => `mowbot_preview_${publicPort}=${secret}`;

describe('previews: the link and its cookie', () => {
  it('swaps the secret of the link for a cookie, then serves the dev server', async () => {
    const { row, token: secret, created } = await share(devPort, '/app?tab=2');
    expect(created).toBe(true);
    expect(row.publicPort).toBe(FIRST);

    // No cookie, no secret: a page saying so, and nothing reaches the dev server.
    const locked = await request(row.publicPort, '/app');
    expect(locked.status).toBe(401);
    expect(locked.headers['content-type']).toContain('text/html');
    expect(locked.body).toContain('private');
    expect(seen).toHaveLength(0);

    const wrong = await request(row.publicPort, `/app?${TOKEN_PARAM}=nope`);
    expect(wrong.status).toBe(403);

    const opened = await request(row.publicPort, `/app?tab=2&${TOKEN_PARAM}=${secret}`);
    expect(opened.status).toBe(302);
    // The secret leaves the address bar; the rest of the address stays.
    expect(opened.headers.location).toBe('/app?tab=2');
    const [cookie] = opened.headers['set-cookie'] ?? [];
    expect(cookie).toContain(cookieOf(row.publicPort, secret));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Secure/);
    expect(seen).toHaveLength(0);

    const page = await request(row.publicPort, '/app?tab=2', {
      cookie: cookieOf(row.publicPort, secret),
    });
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body).url).toBe('/app?tab=2');
  });

  it('marks the cookie Secure when the user came over HTTPS (behind Caddy)', async () => {
    await t.close();
    t = await createTestApp({
      host: '127.0.0.1',
      trustProxy: true,
      previews: { ports: { first: FIRST, last: FIRST + 2 }, publicUrl: undefined, ttlMs: DAY },
    });
    token = (await setupOwner(t.app)).accessToken;
    computerId = (
      await t.app.inject({ method: 'GET', url: '/api/v1/teams', headers: bearer(token) })
    ).json().items[0].computerId;
    const { row, token: secret } = await share();
    const opened = await request(row.publicPort, `/?${TOKEN_PARAM}=${secret}`, {
      'x-forwarded-proto': 'https',
    });
    expect(opened.headers['set-cookie']?.[0]).toMatch(/; Secure/);
  });

  it('never redirects off the preview', async () => {
    const { row, token: secret } = await share();
    const opened = await request(row.publicPort, `//evil.example/x?${TOKEN_PARAM}=${secret}`);
    expect(opened.headers.location).toBe('/evil.example/x');
  });
});

describe('previews: what crosses the proxy', () => {
  it('never shows the hub’s cookies to the dev server, and says it is localhost', async () => {
    const { row, token: secret } = await share();
    const origin = `http://127.0.0.1:${row.publicPort}`;
    const page = await request(row.publicPort, '/echo', {
      // The hub's refresh cookie and another preview's cookie share the jar (same host).
      cookie: `mowbot_refresh=refresh-secret; ${cookieOf(row.publicPort, secret)}; mowbot_preview_9999=other; theme=dark; __Secure-mowbot_y=1`,
      origin,
      referer: `${origin}/page?q=1`,
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
    });
    const { headers } = JSON.parse(page.body) as { headers: http.IncomingHttpHeaders };
    expect(headers.cookie).toBe('theme=dark');
    expect(headers.host).toBe(`localhost:${devPort}`);
    expect(headers.origin).toBe(`http://localhost:${devPort}`);
    expect(headers.referer).toBe(`http://localhost:${devPort}/page?q=1`);
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-forwarded-proto']).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('refresh-secret');
    expect(JSON.stringify(seen)).not.toContain(secret);
  });

  it('never lets the dev server set the hub’s cookies or act on the whole host', async () => {
    const { row, token: secret } = await share();
    const page = await request(row.publicPort, '/cookies', {
      cookie: cookieOf(row.publicPort, secret),
    });
    expect(page.status).toBe(200);
    // Only its own cookie, and only for this host.
    expect(page.headers['set-cookie']).toEqual(['theme=light; Path=/; HttpOnly']);
    expect(page.headers['clear-site-data']).toBeUndefined();
    expect(page.headers['strict-transport-security']).toBeUndefined();
  });

  it('points redirects to the dev server’s own address back at the preview', async () => {
    const { row, token: secret } = await share();
    const page = await request(row.publicPort, '/redirect', {
      cookie: cookieOf(row.publicPort, secret),
    });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe(`http://127.0.0.1:${row.publicPort}/after?x=1`);
  });

  it('carries WebSockets (hot reload), with the same cookie rules', async () => {
    const { row, token: secret } = await share();
    const url = `ws://127.0.0.1:${row.publicPort}/hmr?token=vite`;

    const refused = new WebSocket(url);
    const status = await new Promise<number>((resolve) =>
      refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(401);

    const ws = new WebSocket(url, {
      headers: {
        cookie: `mowbot_refresh=refresh-secret; ${cookieOf(row.publicPort, secret)}; a=1`,
      },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const echoed = new Promise<string>((resolve) =>
      ws.once('message', (data) => resolve(String(data))),
    );
    ws.send('update');
    expect(await echoed).toBe('echo update');
    ws.close();
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]?.cookie).toBe('a=1');
    expect(upgrades[0]?.host).toBe(`localhost:${devPort}`);
  });

  it('says when the dev server is gone', async () => {
    const { row, token: secret } = await share();
    dev.closeAllConnections();
    await new Promise((resolve) => dev.close(resolve));
    const page = await request(row.publicPort, '/', { cookie: cookieOf(row.publicPort, secret) });
    expect(page.status).toBe(502);
    expect(page.body).toContain('not running');
    // afterEach closes it again.
    dev = http.createServer();
    await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  });
});

describe('previews: sharing, stopping, expiry', () => {
  it('refuses a port where nothing listens, and the PC’s own services', async () => {
    await startPc();
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    const attempt = (p: number) =>
      t.services.previews.share({ computerId, botId: null, port: p, title: 'x', path: '/' }).then(
        () => null,
        (error: HttpProblem) => error.code,
      );
    expect(await attempt(port)).toBe('preview_port_closed');
    for (const reserved of [5900, 9222, 7070, 6000]) {
      expect(await attempt(reserved)).toBe('preview_port_reserved');
    }
    expect(await t.services.previews.list()).toEqual([]);
  });

  it('serves nothing on a preview port nobody shared', async () => {
    const { row } = await share();
    await expect(request(row.publicPort + 1, '/')).rejects.toThrow();
  });

  it('keeps the same link when a port is shared again, and pushes the end back', async () => {
    const first = await share();
    offset = 60 * 60 * 1000;
    const again = await t.services.previews.share({
      computerId,
      botId: null,
      port: devPort,
      title: 'Site v2',
      path: '/',
    });
    expect(again.created).toBe(false);
    expect(again.row.publicPort).toBe(first.row.publicPort);
    expect(again.token).toBe(first.token);
    expect(again.row.title).toBe('Site v2');
    expect(again.row.expiresAt.getTime()).toBeGreaterThan(first.row.expiresAt.getTime());
  });

  it('lists previews for the owner only, with links for the address they use', async () => {
    const { row, token: secret } = await share(devPort, '/admin');
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/v1/previews' });
    expect(anonymous.statusCode).toBe(401);

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/previews?computerId=${computerId}`,
      headers: { ...bearer(token), host: '192.168.1.20' },
    });
    const items = res.json().items as Preview[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: row.id,
      computerId,
      title: 'Site',
      port: devPort,
      publicPort: row.publicPort,
      path: '/admin',
      url: `http://192.168.1.20:${row.publicPort}/admin?${TOKEN_PARAM}=${secret}`,
    });
  });

  it('stops: the link and the cookies it gave stop working', async () => {
    const { row, token: secret } = await share();
    const before = await request(row.publicPort, '/', { cookie: cookieOf(row.publicPort, secret) });
    expect(before.status).toBe(200);

    const readOnly = await t.services.tokens.sign({
      ownerId: (
        await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })
      ).json().owner.id,
      deviceId: (
        await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })
      ).json().device.id,
      scopes: ['read'],
    });
    const forbidden = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/previews/${row.id}`,
      headers: bearer(readOnly.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const stopped = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/previews/${row.id}`,
      headers: bearer(token),
    });
    expect(stopped.statusCode).toBe(204);
    expect(events).toContainEqual({ type: 'previews.changed', computerId });
    await expect(
      request(row.publicPort, '/', { cookie: cookieOf(row.publicPort, secret) }),
    ).rejects.toThrow();

    // Shared again: a new secret; the old link and cookie are worthless.
    const next = await share();
    expect(next.token).not.toBe(secret);
    expect(
      (await request(next.row.publicPort, '/', { cookie: cookieOf(next.row.publicPort, secret) }))
        .status,
    ).toBe(401);
    expect((await request(next.row.publicPort, `/?${TOKEN_PARAM}=${secret}`)).status).toBe(403);
  });

  it('ends after 24 hours', async () => {
    const { row, token: secret } = await share();
    offset = DAY + 1_000;
    const late = await request(row.publicPort, '/', { cookie: cookieOf(row.publicPort, secret) });
    expect(late.status).toBe(404);
    expect(late.body).toContain('ended');
    expect(seen).toHaveLength(0);

    await t.services.previews.sweep();
    expect(await t.services.previews.list()).toEqual([]);
    await expect(request(row.publicPort, '/')).rejects.toThrow();
  });

  it('ends when the PC stops', async () => {
    const { row } = await share();
    await t.app.inject({
      method: 'POST',
      url: `/api/v1/computers/${computerId}/stop`,
      headers: bearer(token),
    });
    await expect.poll(() => t.services.previews.list()).toEqual([]);
    await expect
      .poll(() =>
        request(row.publicPort, '/').then(
          () => 'open',
          () => 'closed',
        ),
      )
      .toBe('closed');
  });

  it('takes the next port when one is busy, and says when all are', async () => {
    // Something else on this machine already uses the first port.
    const squatter = http.createServer();
    await new Promise<void>((resolve) => squatter.listen(FIRST, '127.0.0.1', resolve));
    try {
      const { row } = await share();
      expect(row.publicPort).toBe(FIRST + 1);
      const second = http.createServer((_req, res) => res.end('second'));
      await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
      const secondPort = (second.address() as net.AddressInfo).port;
      const third = await t.services.previews.share({
        computerId,
        botId: null,
        port: secondPort,
        title: 'Second',
        path: '/',
      });
      expect(third.row.publicPort).toBe(FIRST + 2);
      const other = http.createServer();
      await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
      const full = await t.services.previews
        .share({
          computerId,
          botId: null,
          port: (other.address() as net.AddressInfo).port,
          title: 'Third',
          path: '/',
        })
        .catch((error: HttpProblem) => error.code);
      expect(full).toBe('preview_ports_full');
      second.close();
      other.close();
    } finally {
      squatter.close();
    }
  });

  it('serves the previews of running PCs again after a hub restart', async () => {
    const { row, token: secret } = await share();
    // As the hub does at startup, once computers are reconciled.
    await t.services.previews.close();
    await expect(request(row.publicPort, '/')).rejects.toThrow();
    await t.services.previews.start();
    const page = await request(row.publicPort, '/', { cookie: cookieOf(row.publicPort, secret) });
    expect(page.status).toBe(200);
  });
});

describe('hub cookies next to previews', () => {
  it('finds the real refresh cookie behind one a preview page planted', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD, device: { name: 'Browser', kind: 'web' } },
    });
    const real = login.cookies.find((c) => c.name === 'mowbot_refresh')?.value as string;
    expect(real).toBeTruthy();
    // document.cookie = 'mowbot_refresh=decoy; path=/api/v1/auth/refresh' on a preview port:
    // the more specific path comes first in the header.
    const refreshed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `mowbot_refresh=decoy; mowbot_refresh=${real}` },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.cookies.find((c) => c.name === 'mowbot_refresh')?.value).not.toBe(real);
  });

  it('never allows a preview port as a CORS origin', async () => {
    await t.close();
    t = await createTestApp({
      host: '127.0.0.1',
      corsOrigins: ['http://localhost:5555', `http://localhost:${FIRST + 1}`],
      previews: { ports: { first: FIRST, last: FIRST + 2 }, publicUrl: undefined, ttlMs: DAY },
    });
    const preflight = (origin: string) =>
      t.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/auth/refresh',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    expect((await preflight('http://localhost:5555')).headers['access-control-allow-origin']).toBe(
      'http://localhost:5555',
    );
    expect(
      (await preflight(`http://localhost:${FIRST + 1}`)).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });
});
