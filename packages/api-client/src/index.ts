import type { TokenResponse } from '@mowbot/contract';
import createClient, { type Client } from 'openapi-fetch';
import type { components, paths } from './schema';

export type { components, paths };
export type MowbotApi = Client<paths>;

export interface MowbotClientOptions {
  /** Origin of the hub, e.g. `https://mowbot.example.com` (empty string for same-origin web). */
  baseUrl: string;
  /**
   * `web`: the refresh token lives in an httpOnly cookie managed by the browser.
   * `native`: the app persists the refresh token itself (Keychain / Keystore) via `onSession`.
   */
  mode: 'web' | 'native';
  /** Called whenever tokens are issued or the session ends (`null`). */
  onSession?: (tokens: TokenResponse | null) => void;
  /** Native only: returns the persisted refresh token. */
  loadRefreshToken?: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}

export interface MowbotClient {
  api: MowbotApi;
  /** Stores tokens returned by setup/login. */
  setSession(tokens: TokenResponse | null): void;
  /** Tries to restore a session from the refresh token. Resolves to whether it worked. */
  refresh(): Promise<boolean>;
  isAuthenticated(): boolean;
  /** Authenticated fetch relative to `baseUrl` (uploads, binary downloads). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Absolute `ws://` / `wss://` URL for a hub path. */
  socketUrl(path: string): string;
}

/** Routes that never carry an access token nor trigger a refresh on 401. */
const PUBLIC_PATHS = new Set([
  '/api/v1/health',
  '/api/v1/auth/status',
  '/api/v1/auth/setup',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
]);
const EXPIRY_MARGIN_MS = 30_000;
const REFRESH_LOCK = 'mowbot-refresh';

export function createMowbotClient(options: MowbotClientOptions): MowbotClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const credentials: RequestCredentials = options.mode === 'web' ? 'include' : 'omit';
  const api = createClient<paths>({ baseUrl: options.baseUrl, credentials, fetch: fetchImpl });

  let access: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<boolean> | null = null;
  const retries = new Map<string, Request>();

  const setSession = (tokens: TokenResponse | null) => {
    access = tokens
      ? { token: tokens.accessToken, expiresAt: Date.parse(tokens.accessTokenExpiresAt) }
      : null;
    options.onSession?.(tokens);
  };

  const doRefresh = async (): Promise<boolean> => {
    const refreshToken = options.mode === 'native' ? await options.loadRefreshToken?.() : undefined;
    if (options.mode === 'native' && !refreshToken) return false;
    const response = await fetchImpl(`${options.baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
    if (!response.ok) {
      setSession(null);
      return false;
    }
    setSession((await response.json()) as TokenResponse);
    return true;
  };

  const refresh = (): Promise<boolean> => {
    inflight ??= (async () => {
      // Browser tabs share the rotating refresh cookie: serialize their refreshes.
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      return locks ? locks.request(REFRESH_LOCK, doRefresh) : doRefresh();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  api.use({
    async onRequest({ request, schemaPath, id }) {
      if (PUBLIC_PATHS.has(schemaPath)) return request;
      if (access && access.expiresAt - Date.now() < EXPIRY_MARGIN_MS) await refresh();
      if (access) request.headers.set('authorization', `Bearer ${access.token}`);
      retries.set(id, request.clone());
      return request;
    },
    async onResponse({ response, schemaPath, id }) {
      const retry = retries.get(id);
      retries.delete(id);
      if (response.status !== 401 || PUBLIC_PATHS.has(schemaPath) || !retry) return response;
      if (!(await refresh()) || !access) return response;
      retry.headers.set('authorization', `Bearer ${access.token}`);
      return fetchImpl(retry);
    },
    onError({ id }) {
      retries.delete(id);
    },
  });

  /** Raw fetch with the same auth handling, for what typed calls cannot express (multipart, blobs). */
  const authorizedFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    if (access && access.expiresAt - Date.now() < EXPIRY_MARGIN_MS) await refresh();
    const send = () => {
      const headers = new Headers(init.headers);
      if (access) headers.set('authorization', `Bearer ${access.token}`);
      return fetchImpl(`${options.baseUrl}${path}`, { ...init, headers, credentials });
    };
    const response = await send();
    if (response.status !== 401 || !(await refresh())) return response;
    return send();
  };

  /** WebSocket URL for a path, e.g. `/api/v1/events?ticket=…`. */
  const socketUrl = (path: string): string => {
    const origin = options.baseUrl || globalThis.location.origin;
    const url = new URL(path, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  };

  return {
    api,
    setSession,
    refresh,
    isAuthenticated: () => access !== null,
    fetch: authorizedFetch,
    socketUrl,
  };
}
