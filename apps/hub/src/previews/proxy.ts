import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { TunnelRefusedError } from '../computers/agent-client';
import { cookieValues, safeSetCookie, withoutHubCookies } from '../http/cookies';

/** The link's query parameter carrying the preview's secret (swapped for a cookie). */
export const TOKEN_PARAM = 'mowbot_preview';

/** Cookie of the preview served on a port (cookies are not scoped by port: one name each). */
export const previewCookie = (publicPort: number) => `mowbot_preview_${publicPort}`;

/** What the server of a public port needs to know about the preview it serves. */
export interface PreviewTarget {
  id: string;
  computerId: string;
  /** The dev server's port on the PC. */
  port: number;
  publicPort: number;
  token: string;
  expiresAt: Date;
}

export interface PreviewProxyDeps {
  /** The preview served on this port now (null: none, or it ended). */
  lookup(publicPort: number): PreviewTarget | null;
  /** A raw connection to the dev server, through the PC's mow-agent. */
  tunnel(target: PreviewTarget): Promise<net.Socket>;
  /** Someone looks at the preview: the PC is in use. */
  touch(target: PreviewTarget): void;
  /** Behind Caddy: X-Forwarded-Proto tells whether the user came over HTTPS. */
  trustProxy: boolean;
  now(): number;
}

export interface PreviewServer {
  readonly publicPort: number;
  listen(host: string): Promise<void>;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers the dev server never gets: what the hub's proxy (Caddy) added, and `Expect`
 * (this server already answered the 100 Continue; the body is streamed right away).
 */
const DROPPED_REQUEST = new Set(['forwarded', 'x-real-ip', 'via', 'expect']);

/**
 * Response headers a preview may not send: they act on the whole host (every port), i.e. on
 * the hub too. `Clear-Site-Data: "cookies"` would sign the user out of the hub.
 */
const DROPPED_RESPONSE = new Set(['clear-site-data', 'strict-transport-security', 'alt-svc']);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison of a secret. */
export function sameSecret(offered: string, expected: string): boolean {
  return timingSafeEqual(digest(offered), digest(expected));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
}

/** `https://mowbot.example.com:8800`: where the user's browser thinks it is. */
function originOf(request: http.IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? firstHeader(request.headers['x-forwarded-proto']) : undefined;
  const protocol = forwarded === 'https' ? 'https' : 'http';
  return `${protocol}://${request.headers.host ?? 'localhost'}`;
}

/** Headers named in `Connection` are hop-by-hop too. */
function connectionTokens(headers: http.IncomingHttpHeaders): Set<string> {
  return new Set(
    (firstHeaderList(headers.connection) ?? []).map((token) => token.trim().toLowerCase()),
  );
}

function firstHeaderList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.join(',') : value).split(',');
}

/**
 * What the dev server receives: as if the user browsed it on the PC itself (`Host`, `Origin`
 * and `Referer` say localhost, so host and CSRF checks pass), without the hub's cookies.
 */
export function upstreamHeaders(
  incoming: http.IncomingHttpHeaders,
  port: number,
  origin: string,
  upgrade: boolean,
): http.OutgoingHttpHeaders {
  const local = `http://localhost:${port}`;
  const named = connectionTokens(incoming);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key) || named.has(key) || DROPPED_REQUEST.has(key)) continue;
    if (key.startsWith('x-forwarded-') || key === 'cookie' || key === 'host') continue;
    headers[key] = value;
  }
  headers.host = `localhost:${port}`;
  const cookie = withoutHubCookies(
    Array.isArray(incoming.cookie) ? incoming.cookie.join('; ') : incoming.cookie,
  );
  if (cookie) headers.cookie = cookie;
  if (incoming.origin === origin) headers.origin = local;
  const referer = firstHeader(incoming.referer);
  if (referer && (referer === origin || referer.startsWith(`${origin}/`))) {
    headers.referer = local + referer.slice(origin.length);
  }
  if (upgrade) {
    headers.connection = 'Upgrade';
    if (incoming.upgrade) headers.upgrade = incoming.upgrade;
  } else if (incoming['transfer-encoding'] && incoming['content-length'] === undefined) {
    // A streamed body stays streamed (Node chunks what is piped).
    headers['transfer-encoding'] = 'chunked';
  }
  return headers;
}

/** A redirect to the dev server's own address points back at the preview. */
export function rewriteLocation(location: string, port: number, origin: string): string {
  try {
    const url = new URL(location);
    const urlPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (LOOPBACK_HOSTS.has(url.hostname) && urlPort === port) {
      return `${origin}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Relative: already right.
  }
  return location;
}

/**
 * What the browser receives from the dev server: no hop-by-hop headers, no headers acting on
 * the whole host, no cookies of the hub, cookies only for this host. Raw pairs, flattened.
 */
export function downstreamHeaders(rawHeaders: string[], port: number, origin: string): string[] {
  const named = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === 'connection') {
      for (const token of (rawHeaders[i + 1] ?? '').split(',')) {
        named.add(token.trim().toLowerCase());
      }
    }
  }
  const out: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i] ?? '';
    let value = rawHeaders[i + 1] ?? '';
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || named.has(key) || DROPPED_RESPONSE.has(key)) continue;
    if (key === 'set-cookie') {
      const safe = safeSetCookie(value);
      if (safe === null) continue;
      value = safe;
    }
    if (key === 'location' || key === 'content-location')
      value = rewriteLocation(value, port, origin);
    out.push(name, value);
  }
  return out;
}

type PageKind = 'locked' | 'invalid' | 'gone' | 'closed' | 'unreachable';

const PAGES: Record<PageKind, { status: number; en: [string, string]; fr: [string, string] }> = {
  locked: {
    status: 401,
    en: ['This preview is private', 'Open it with the link the bot gave you.'],
    fr: ['Cet aperçu est privé', 'Ouvre-le avec le lien que le bot t’a donné.'],
  },
  invalid: {
    status: 403,
    en: [
      'This link is not valid',
      'The preview was stopped or shared again: ask the bot for its link.',
    ],
    fr: [
      'Ce lien n’est pas valable',
      'L’aperçu a été arrêté ou partagé à nouveau : demande son lien au bot.',
    ],
  },
  gone: {
    status: 404,
    en: [
      'This preview has ended',
      'A preview ends when the bot’s PC stops or goes to sleep, and after 24 hours. Ask the bot to share it again.',
    ],
    fr: [
      'Cet aperçu est terminé',
      'Un aperçu s’arrête quand le PC du bot s’éteint ou se met en veille, et au bout de 24 heures. Demande au bot de le partager à nouveau.',
    ],
  },
  closed: {
    status: 502,
    en: [
      'The page is not running',
      'Nothing listens on its port of the bot’s PC any more: ask the bot to start its server again.',
    ],
    fr: [
      'La page ne tourne plus',
      'Plus rien n’écoute sur son port du PC du bot : demande au bot de relancer son serveur.',
    ],
  },
  unreachable: {
    status: 502,
    en: ['The bot’s PC is not reachable', 'Try again in a moment.'],
    fr: ['Le PC du bot ne répond pas', 'Réessaie dans un instant.'],
  },
};

function sendPage(request: http.IncomingMessage, response: http.ServerResponse, kind: PageKind) {
  const page = PAGES[kind];
  const french = /^fr\b/i.test(request.headers['accept-language'] ?? '');
  const [title, text] = french ? page.fr : page.en;
  const body = `<!doctype html><html lang="${french ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0c10;color:#e8e8ea}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#a1a1aa}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  response.writeHead(page.status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(body);
}

/** The path of a request, never protocol-relative (`//other.site` would leave the preview). */
function safePath(url: URL): string {
  return `/${url.pathname.replace(/^\/+/, '')}${url.search}`;
}

/** A request's target as a URL (`//x/y` is a path here, not another host). */
function targetOf(raw: string | undefined): URL | null {
  try {
    const target = raw ?? '/';
    return target.startsWith('/') ? new URL(`http://preview${target}`) : new URL(target);
  } catch {
    return null;
  }
}

function hasAccess(request: http.IncomingMessage, target: PreviewTarget): boolean {
  return cookieValues(request.headers.cookie, previewCookie(target.publicPort)).some((value) =>
    sameSecret(value, target.token),
  );
}

function errorKind(error: unknown): PageKind {
  return error instanceof TunnelRefusedError ? 'closed' : 'unreachable';
}

function rawResponseHead(status: number, message: string, headers: string[]): string {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i < headers.length; i += 2) head += `${headers[i]}: ${headers[i + 1]}\r\n`;
  return `${head}\r\n`;
}

/**
 * Serves one preview port: the link's secret becomes a cookie (and leaves the address bar),
 * then every request and WebSocket goes to the dev server on the PC, through its mow-agent.
 */
export function createPreviewServer(publicPort: number, deps: PreviewProxyDeps): PreviewServer {
  const upgraded = new Set<Duplex>();

  const current = (): PreviewTarget | null => {
    const target = deps.lookup(publicPort);
    return target && target.expiresAt.getTime() > deps.now() ? target : null;
  };

  const server = http.createServer((request, response) => {
    const target = current();
    if (!target) return sendPage(request, response, 'gone');
    const origin = originOf(request, deps.trustProxy);
    const url = targetOf(request.url);
    if (!url) {
      response.writeHead(400, { 'content-length': 0 });
      return response.end();
    }

    const offered = url.searchParams.get(TOKEN_PARAM);
    if (offered !== null) {
      if (!sameSecret(offered, target.token)) return sendPage(request, response, 'invalid');
      url.searchParams.delete(TOKEN_PARAM);
      const cookie = [
        `${previewCookie(publicPort)}=${target.token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Expires=${target.expiresAt.toUTCString()}`,
        ...(origin.startsWith('https:') ? ['Secure'] : []),
      ].join('; ');
      response.writeHead(302, {
        location: safePath(url),
        'set-cookie': cookie,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return response.end();
    }
    if (!hasAccess(request, target)) return sendPage(request, response, 'locked');
    deps.touch(target);

    const upstream = http.request({
      method: request.method,
      path: request.url?.startsWith('/') ? request.url : `${url.pathname}${url.search}`,
      headers: upstreamHeaders(request.headers, target.port, origin, false),
      createConnection: (_options, callback) => {
        deps.tunnel(target).then(
          (socket) => callback(null, socket),
          (error: Error) => callback(error, undefined as unknown as Duplex),
        );
        return undefined;
      },
    });
    upstream.on('response', (reply) => {
      response.writeHead(
        reply.statusCode ?? 502,
        reply.statusMessage,
        downstreamHeaders(reply.rawHeaders, target.port, origin),
      );
      reply.pipe(response);
      reply.on('error', () => response.destroy());
    });
    upstream.on('error', (error) => {
      if (!response.headersSent) sendPage(request, response, errorKind(error));
      else response.destroy();
    });
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  });

  /** WebSockets (hot reload): authenticated like the page, then bytes both ways. */
  server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = current();
    const refuse = (status: string) =>
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!target) return refuse('404 Not Found');
    if (!hasAccess(request, target)) return refuse('401 Unauthorized');
    deps.touch(target);
    const origin = originOf(request, deps.trustProxy);
    socket.on('error', () => socket.destroy());

    const upstream = http.request({
      method: request.method,
      path: request.url ?? '/',
      headers: upstreamHeaders(request.headers, target.port, origin, true),
      createConnection: (_options, callback) => {
        deps.tunnel(target).then(
          (tunnel) => callback(null, tunnel),
          (error: Error) => callback(error, undefined as unknown as Duplex),
        );
        return undefined;
      },
    });
    upstream.on('upgrade', (reply, tunnel, replyHead) => {
      if (socket.destroyed) {
        tunnel.destroy();
        return;
      }
      upgraded.add(socket);
      socket.write(
        rawResponseHead(
          101,
          reply.statusMessage || 'Switching Protocols',
          // Connection and Upgrade are hop-by-hop, but a 101 needs them.
          [
            'Connection',
            'Upgrade',
            'Upgrade',
            reply.headers.upgrade ?? 'websocket',
            ...downstreamHeaders(reply.rawHeaders, target.port, origin),
          ],
        ),
      );
      if (replyHead.length > 0) socket.write(replyHead);
      if (head.length > 0) tunnel.write(head);
      tunnel.pipe(socket);
      socket.pipe(tunnel);
      const closeAll = () => {
        upgraded.delete(socket);
        tunnel.destroy();
        socket.destroy();
      };
      tunnel.on('error', closeAll);
      tunnel.on('close', closeAll);
      socket.on('close', closeAll);
      // Messages back and forth are activity too (the touch is throttled).
      tunnel.on('data', () => deps.touch(target));
    });
    upstream.on('response', (reply) => {
      // The dev server refused the upgrade: pass its answer on, then close.
      socket.write(
        rawResponseHead(reply.statusCode ?? 502, reply.statusMessage ?? '', [
          ...downstreamHeaders(reply.rawHeaders, target.port, origin),
          'Connection',
          'close',
        ]),
      );
      reply.pipe(socket);
    });
    upstream.on('error', () => refuse('502 Bad Gateway'));
    upstream.end();
  });

  return {
    publicPort,
    listen: (host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(publicPort, host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
