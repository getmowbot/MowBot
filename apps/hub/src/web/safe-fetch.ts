import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';

/**
 * Addresses the hub never fetches for a bot: its own machine, the local networks (the
 * computers', the user's), link-local and cloud metadata, multicast. A page on the web only.
 */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // IPv4 written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Refused before anything was sent: the bot reads why. */
export class FetchRefused extends Error {}

const LOCAL =
  'est une adresse locale : seules les pages publiques du web se lisent ainsi (pour un serveur de ton PC, utilise bash ou le navigateur).';

/**
 * Resolves like the system, but refuses a name that leads to a private address. It runs at
 * connection time: a name cannot pass a check, then point elsewhere (DNS rebinding).
 */
export function guardedLookup(resolve: typeof dnsLookup = dnsLookup): LookupFunction {
  return (host, options, callback) => {
    resolve(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      const list = addresses as unknown as LookupAddress[];
      const bad = list.find((entry) => isPrivateAddress(entry.address));
      if (bad || list.length === 0) {
        return callback(new FetchRefused(`${host} ${LOCAL}`), '', 0);
      }
      if ((options as { all?: boolean }).all) {
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      }
      const [first] = list as [LookupAddress];
      callback(null, first.address, first.family);
    });
  };
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** How host names resolve (tests). */
  resolve?: typeof dnsLookup;
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** Longer than `maxBytes`: the end was left out. */
  cut: boolean;
}

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36 MowBot';

/**
 * Fetches a public web page for a bot: http(s) only, never a private address (each redirect
 * checked again), at most `maxBytes` read, its body as text.
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let current = new URL(url);
  let method = options.method ?? 'GET';
  let body = options.body;
  for (let hop = 0; hop < 6; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new FetchRefused('Seules les adresses http(s) se lisent.');
    }
    if (current.username || current.password) {
      throw new FetchRefused('Une adresse avec identifiants ne se lit pas ainsi.');
    }
    const host = current.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) throw new FetchRefused(`${host} ${LOCAL}`);
    const page = await request(current, {
      method,
      body,
      headers: options.headers ?? {},
      timeoutMs: Math.max(1_000, deadline - Date.now()),
      maxBytes: options.maxBytes ?? 2_000_000,
      lookup: guardedLookup(options.resolve),
    });
    if (page.status >= 300 && page.status < 400 && page.location) {
      current = new URL(page.location, current);
      // A redirected form becomes a plain visit (303, and what browsers do for 301/302).
      if (page.status !== 307 && page.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { ...page, url: current.toString() };
  }
  throw new FetchRefused('Trop de redirections.');
}

function request(
  url: URL,
  options: {
    method: string;
    body: string | undefined;
    headers: Record<string, string>;
    timeoutMs: number;
    maxBytes: number;
    lookup: LookupFunction;
  },
): Promise<Omit<FetchedPage, 'url'> & { location: string | null }> {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: options.method,
        lookup: options.lookup,
        timeout: options.timeoutMs,
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'fr,en;q=0.8',
          'accept-encoding': 'gzip, deflate, br',
          ...options.headers,
          ...(options.body ? { 'content-length': String(Buffer.byteLength(options.body)) } : {}),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location ?? null;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ status, location, contentType: '', body: '', cut: false });
        }
        const encoding = String(res.headers['content-encoding'] ?? '');
        const stream =
          encoding === 'gzip'
            ? res.pipe(zlib.createGunzip())
            : encoding === 'deflate'
              ? res.pipe(zlib.createInflate())
              : encoding === 'br'
                ? res.pipe(zlib.createBrotliDecompress())
                : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let cut = false;
        const done = () =>
          resolve({
            status,
            location: null,
            contentType: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
            cut,
          });
        stream.on('data', (chunk: Buffer) => {
          if (cut) return;
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            chunks.push(chunk.subarray(0, chunk.byteLength - (size - options.maxBytes)));
            cut = true;
            res.destroy();
            done();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => !cut && done());
        stream.on('error', (error) => !cut && reject(error));
      },
    );
    req.on('timeout', () => req.destroy(new Error('La page met trop de temps à répondre.')));
    req.on('error', (error) => {
      const cause = (error as { cause?: unknown }).cause;
      reject(cause instanceof FetchRefused ? cause : error);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}
