import { createMowbotClient, type MowbotApi, type MowbotClient } from '@mowbot/api-client';
import type { TokenResponse } from '@mowbot/contract';
import * as Device from 'expo-device';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { eventsSocketUrl, normalizeHubUrl, problemCode } from './hub-url';
import { readSync, write } from './storage';

/**
 * The signed-in device: which hub, the hub client, and the tokens. Native devices receive
 * their refresh token in the JSON body and keep it in the Keychain / Keystore; the short-lived
 * access token only lives in memory.
 */
export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn' | 'unreachable';

export interface SessionState {
  status: SessionStatus;
  hubUrl: string | null;
  /** Why the user landed back on the connect screen, if it was not their choice. */
  notice: 'sessionExpired' | null;
}

let state: SessionState = { status: 'restoring', hubUrl: readSync('hubUrl'), notice: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useSession(): SessionState {
  return useSyncExternalStore(subscribe, () => state);
}

let client: MowbotClient | null = null;
let refreshToken: string | null = readSync('refreshToken');
let accessToken: string | null = null;
let lastRefreshStatus: number | null = null;
let signingOut = false;

const REQUEST_TIMEOUT_MS = 8_000;

/** Remembers how the hub answered the last refresh, to tell "signed out" from "hub down". */
const trackingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
  if (url.endsWith('/api/v1/auth/refresh')) lastRefreshStatus = response.status;
  return response;
};

/** 4xx (except rate limiting) on refresh: the token is dead (revoked, expired, reused). */
const refreshRejected = () =>
  lastRefreshStatus !== null &&
  lastRefreshStatus >= 400 &&
  lastRefreshStatus < 500 &&
  lastRefreshStatus !== 429;

function forgetRefreshToken() {
  refreshToken = null;
  void write('refreshToken', null);
}

function onSession(tokens: TokenResponse | null) {
  if (tokens) {
    accessToken = tokens.accessToken;
    if (tokens.refreshToken) {
      refreshToken = tokens.refreshToken;
      void write('refreshToken', tokens.refreshToken);
    }
    return;
  }
  accessToken = null;
  if (signingOut) return;
  const rejected = refreshRejected();
  if (rejected) forgetRefreshToken();
  // Lost mid-session: back to the connect screen (expired) or a retry screen (hub down).
  if (state.status === 'signedIn') {
    setState(
      rejected ? { status: 'signedOut', notice: 'sessionExpired' } : { status: 'unreachable' },
    );
  }
}

function makeClient(baseUrl: string): MowbotClient {
  return createMowbotClient({
    baseUrl,
    mode: 'native',
    loadRefreshToken: async () => refreshToken,
    onSession,
    fetch: trackingFetch,
  });
}

function deviceInfo() {
  const fallback = Platform.OS === 'ios' ? 'iPhone' : 'Android';
  const name = (Device.deviceName ?? Device.modelName ?? fallback).slice(0, 100);
  return { name, kind: Platform.OS === 'ios' ? ('ios' as const) : ('android' as const) };
}

export function deviceName(): string {
  return deviceInfo().name;
}

/** Aborts a request that hangs (a wrong LAN address can take a minute to time out). */
function timeoutSignal(ms = REQUEST_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Launch: resume the stored session if there is one. */
export async function restoreSession(): Promise<void> {
  const { hubUrl } = state;
  if (!hubUrl || !refreshToken) {
    setState({ status: 'signedOut' });
    return;
  }
  client = makeClient(hubUrl);
  lastRefreshStatus = null;
  try {
    const restored = await client.refresh();
    if (restored) setState({ status: 'signedIn', notice: null });
    else setState(refreshRejected() ? { status: 'signedOut' } : { status: 'unreachable' });
  } catch {
    setState({ status: 'unreachable' });
  }
}

export type SignInError =
  | 'invalidUrl'
  | 'unreachable'
  | 'setupRequired'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'validation_failed'
  | 'generic';

export class SignInFailure extends Error {
  constructor(readonly reason: SignInError) {
    super(reason);
  }
}

const KNOWN_PROBLEMS = new Set<SignInError>([
  'invalid_credentials',
  'rate_limited',
  'validation_failed',
]);

export async function signIn(rawHubUrl: string, password: string): Promise<void> {
  const hubUrl = normalizeHubUrl(rawHubUrl);
  if (!hubUrl) throw new SignInFailure('invalidUrl');
  const next = makeClient(hubUrl);

  const status = await next.api
    .GET('/api/v1/auth/status', { signal: timeoutSignal() })
    .catch(() => null);
  if (!status) throw new SignInFailure('unreachable');
  if (!status.data) throw new SignInFailure('generic');
  if (status.data.setupRequired) throw new SignInFailure('setupRequired');

  const login = await next.api
    .POST('/api/v1/auth/login', {
      body: { password, device: deviceInfo() },
      signal: timeoutSignal(),
    })
    .catch(() => null);
  if (!login) throw new SignInFailure('unreachable');
  if (!login.data) {
    const code = problemCode(login.error) as SignInError | null;
    throw new SignInFailure(code && KNOWN_PROBLEMS.has(code) ? code : 'generic');
  }

  client = next;
  next.setSession(login.data);
  void write('hubUrl', hubUrl);
  setState({ status: 'signedIn', hubUrl, notice: null });
}

/** Revokes this device on the hub (best effort) and forgets the session. */
export async function signOut(): Promise<void> {
  signingOut = true;
  try {
    await client?.api.POST('/api/v1/auth/logout', { signal: timeoutSignal(4_000) });
  } catch {
    // Offline: the device stays listed on the hub until revoked from the web.
  }
  client?.setSession(null);
  signingOut = false;
  accessToken = null;
  forgetRefreshToken();
  setState({ status: 'signedOut', notice: null });
}

export function api(): MowbotApi {
  if (!client) throw new Error('No hub client: sign in first');
  return client.api;
}

/** Bearer header for what typed calls cannot do (images loaded by URL). */
export function authHeaders(): Record<string, string> {
  return accessToken ? { authorization: `Bearer ${accessToken}` } : {};
}

export function hubUrl(): string | null {
  return state.hubUrl;
}

export function eventsUrl(ticket: string): string {
  if (!state.hubUrl) throw new Error('No hub');
  return eventsSocketUrl(state.hubUrl, ticket);
}
