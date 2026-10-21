import { createOpenAI } from '@ai-sdk/openai';
import {
  CHATGPT_USAGE_URL,
  type ChatgptCredential,
  type ChatgptSignIn,
  type ChatgptStatus,
  type Locale,
} from '@mowbot/contract';
import { APICallError, type LanguageModel, wrapLanguageModel } from 'ai';
import { eq } from 'drizzle-orm';
import { createRemoteJWKSet, decodeJwt, type JWTPayload, jwtVerify } from 'jose';
import { CHATGPT_DEFAULTS, type ChatgptOptions } from '../config';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { type OAuthAccount, providerProfiles, settings } from '../db/schema';
import { HttpProblem } from '../http/problems';
import { ownerLocale } from '../i18n';

/**
 * "Sign in with ChatGPT" (OpenAI's token sharing for open-source clients): bots run on the
 * user's ChatGPT plan. The desktop app does the OAuth on the user's computer (a loopback
 * redirect only reaches the machine running the browser) and hands the tokens to the hub, which
 * is the host that uses them: it checks the ID token, seals the tokens, renews them itself and
 * calls the Responses API with `store: false`. Spec: developers.openai.com/siwc.
 */

/** The `resource` the tokens are issued for (an identifier, the same in tests). */
const RESOURCE = 'https://api.openai.com/v1';
/** Without it a valid sign-in does not allow using the plan. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
/** `agent_name_hint` of a new registration. */
export const AGENT_NAME = 'MowBot';
/** `ext_agent_host_id` of this hub, in `settings`. */
const HOST_ID_KEY = 'chatgpt.hostId';
const TOKENS_PURPOSE = 'provider-chatgpt-tokens';
/** Access tokens last an hour: renewed when less than this is left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** After a usage limit, the plan is left alone this long (bots use their fallbacks). */
const LIMIT_PAUSE_MS = 5 * 60_000;
/** How much of a stream is read to catch an error sent before any output. */
const PEEK_BYTES = 64 * 1024;

/** Parameters ChatGPT plan usage refuses (preview limitations), dropped from every request. */
const UNSUPPORTED_PARAMS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'previous_response_id',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'service_tier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
];

/** Refresh answers that mean the session is over: sign in again (errors and recovery). */
const TERMINAL_REFRESH_STATUSES = new Set([400, 401, 403]);

interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms, when OpenAI gave `earliest_refresh_at`. */
  earliestRefreshAt: number | null;
  scope: string;
}

type PlanError = 'usageLimit' | 'usageUnavailable' | 'notEligible' | 'unavailable' | 'unsupported';

/** Structured Responses errors of plan usage, by `error.code`. */
const PLAN_ERRORS: Record<string, { kind: PlanError; status: number }> = {
  subscription_sharing_usage_limit_exceeded: { kind: 'usageLimit', status: 429 },
  subscription_sharing_usage_unavailable: { kind: 'usageUnavailable', status: 503 },
  subscription_sharing_user_not_eligible: { kind: 'notEligible', status: 403 },
  subscription_sharing_user_unavailable: { kind: 'unavailable', status: 503 },
  subscription_sharing_unsupported_capability: { kind: 'unsupported', status: 400 },
};

interface Texts {
  usageLimit: string;
  usageUnavailable: string;
  notEligible: string;
  unavailable: string;
  unsupported(param: string | null): string;
  signInAgain: string;
  refreshUnavailable: string;
}

/** What the user reads (bot errors, model list), in the owner's language. */
const TEXTS: Record<Locale, Texts> = {
  fr: {
    usageLimit: `Limite d'utilisation de ChatGPT atteinte (celle du forfait ou une limite propre à l'app) : voir ${CHATGPT_USAGE_URL}.`,
    usageUnavailable:
      "ChatGPT n'a pas pu vérifier l'utilisation du forfait pour l'instant : réessaie dans un moment.",
    notEligible:
      'Ce compte ChatGPT ne peut pas utiliser son forfait dans MowBot (forfait, espace de travail ou règle de son organisation).',
    unavailable: 'ChatGPT est momentanément indisponible pour ce compte : réessaie dans un moment.',
    unsupported: (param) =>
      `Le forfait ChatGPT ne prend pas en charge cette requête${param ? ` (${param})` : ''}.`,
    signInAgain:
      "La session ChatGPT a pris fin : reconnecte-toi depuis l'app desktop MowBot (Réglages → Modèles).",
    refreshUnavailable:
      'Impossible de renouveler la session ChatGPT pour le moment (OpenAI ne répond pas).',
  },
  en: {
    usageLimit: `ChatGPT usage limit reached (the plan's, or a limit for this app): see ${CHATGPT_USAGE_URL}.`,
    usageUnavailable: "ChatGPT couldn't check the plan's usage right now: try again in a moment.",
    notEligible:
      "This ChatGPT account can't use its plan in MowBot (plan, workspace or its organization's policy).",
    unavailable: 'ChatGPT is temporarily unavailable for this account: try again in a moment.',
    unsupported: (param) =>
      `The ChatGPT plan doesn't support this request${param ? ` (${param})` : ''}.`,
    signInAgain:
      'The ChatGPT session ended: sign in again from the MowBot desktop app (Settings → Models).',
    refreshUnavailable: "Couldn't renew the ChatGPT session right now (OpenAI isn't answering).",
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scopesOf = (scope: string) => scope.split(/\s+/).filter(Boolean);

/** `earliest_refresh_at` as epoch ms (Unix seconds or ms, or an ISO date). */
export function parseInstant(value: unknown, now = Date.now()): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number)) {
    if (number > 1e12) return number;
    if (number > 1e9) return number * 1000;
    // A small number reads as seconds from now.
    return number >= 0 ? now + number * 1000 : null;
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** The plan type the ID token may carry (`https://api.openai.com/auth`.chatgpt_plan_type). */
function planTypeOf(claims: JWTPayload): string | null {
  const auth = claims['https://api.openai.com/auth'];
  const plan = isRecord(auth) ? auth.chatgpt_plan_type : undefined;
  return typeof plan === 'string' && plan ? plan : null;
}

const emailOf = (claims: JWTPayload): string | null =>
  typeof claims.email === 'string' && claims.email ? claims.email : null;

/**
 * A Responses request as plan usage takes it: never stored, without the parameters it refuses,
 * system instructions as developer messages.
 */
export function planRequestBody(body: string): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(value)) return body;
  for (const key of UNSUPPORTED_PARAMS) delete value[key];
  value.store = false;
  if (Array.isArray(value.input)) {
    value.input = value.input.map((item: unknown) =>
      isRecord(item) && item.role === 'system' ? { ...item, role: 'developer' } : item,
    );
  }
  return JSON.stringify(value);
}

/** The first event of a Responses stream that tells how it goes: `null` while undecided. */
export function streamVerdict(text: string): { code: string | null; param: string | null } | null {
  const events = text.split(/\r?\n\r?\n/);
  // The last piece may be an event still arriving.
  for (const event of events.slice(0, -1)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    if (data === '[DONE]') return { code: null, param: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { code: null, param: null };
    }
    if (!isRecord(parsed)) return { code: null, param: null };
    const type = parsed.type;
    if (
      type === 'response.created' ||
      type === 'response.in_progress' ||
      type === 'response.queued'
    ) {
      continue;
    }
    const error =
      type === 'response.failed' && isRecord(parsed.response)
        ? parsed.response.error
        : type === 'error'
          ? (parsed.error ?? parsed)
          : null;
    if (!isRecord(error)) return { code: null, param: null };
    return {
      code: typeof error.code === 'string' ? error.code : null,
      param: typeof error.param === 'string' ? error.param : null,
    };
  }
  return null;
}

/** OpenAI's error code in a failed answer (`{ error: { code } }`, or `{ error: "code" }`). */
function errorCodeOf(body: unknown): { code: string | null; param: string | null } {
  if (!isRecord(body)) return { code: null, param: null };
  const error = body.error;
  if (typeof error === 'string') return { code: error, param: null };
  if (isRecord(error)) {
    return {
      code: typeof error.code === 'string' ? error.code : null,
      param: typeof error.param === 'string' ? error.param : null,
    };
  }
  return { code: null, param: null };
}

const JWT_INVALID = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
]);

/** What `provider_profiles` keeps of a sign-in. */
export interface SignedIn {
  oauthSealed: string;
  oauthAccount: OAuthAccount;
}

/** Tokens, renewal, models and inference of the `openai-chatgpt` providers. */
export class ChatgptService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  /** Per provider: renewals (and other writes of its session) one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Per provider: no request to the plan before this time (epoch ms), after a usage limit. */
  private readonly pausedUntil = new Map<string, number>();
  /** Per provider: the status read with its last token, to note when it works again. */
  private readonly lastStatus = new Map<string, ChatgptStatus>();

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    readonly options: ChatgptOptions = CHATGPT_DEFAULTS,
  ) {}

  /** This hub's `ext_agent_host_id`: made once, then kept (`urn:uuid:` + UUIDv4). */
  async hostId(): Promise<string> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, HOST_ID_KEY));
    if (typeof row?.value === 'string') return row.value;
    await this.db
      .insert(settings)
      .values({ key: HOST_ID_KEY, value: `urn:uuid:${crypto.randomUUID()}` })
      .onConflictDoNothing();
    const [winner] = await this.db.select().from(settings).where(eq(settings.key, HOST_ID_KEY));
    if (typeof winner?.value !== 'string') throw new Error('ChatGPT host id not saved');
    return winner.value;
  }

  /** What the desktop app needs to sign in (again, with `account`). */
  async signInParams(account: OAuthAccount | null): Promise<ChatgptSignIn> {
    return {
      hostId: await this.hostId(),
      agentName: AGENT_NAME,
      clientId: account?.clientId ?? null,
      loginHint: account?.email ?? null,
    };
  }

  /**
   * Checks what the desktop app got from OpenAI: the ID token (signature, issuer, audience = the
   * issued client, expiry, nonce), the plan scope, and when signing in again, the same account.
   */
  async accept(credential: ChatgptCredential, previous: OAuthAccount | null): Promise<SignedIn> {
    if (credential.clientId === 'dynamic_agent_client') {
      throw new HttpProblem(400, 'chatgpt_incomplete', 'OpenAI did not issue a client');
    }
    if (!scopesOf(credential.scope).includes(PLAN_SCOPE)) {
      throw new HttpProblem(
        400,
        'chatgpt_plan_not_granted',
        'Using the ChatGPT plan was not allowed during the sign-in',
      );
    }
    this.jwks ??= createRemoteJWKSet(new URL(`${this.options.authUrl}/.well-known/jwks.json`));
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(credential.idToken, this.jwks, {
        issuer: this.options.authUrl,
        audience: credential.clientId,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      }));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && JWT_INVALID.has(code)) {
        throw new HttpProblem(400, 'chatgpt_invalid_id_token', (error as Error).message);
      }
      throw new HttpProblem(502, 'provider_unreachable', (error as Error).message);
    }
    if (claims.nonce !== credential.nonce) {
      throw new HttpProblem(400, 'chatgpt_invalid_id_token', 'The ID token is for another sign-in');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) {
      throw new HttpProblem(400, 'chatgpt_invalid_id_token', 'The ID token names no account');
    }
    if (
      previous &&
      (previous.subject !== claims.sub || previous.clientId !== credential.clientId)
    ) {
      throw new HttpProblem(
        409,
        'chatgpt_other_account',
        `Signed in with another ChatGPT account than ${previous.email ?? 'before'}`,
      );
    }
    const now = Date.now();
    const tokens: Tokens = {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      idToken: credential.idToken,
      expiresAt: now + credential.expiresIn * 1000,
      earliestRefreshAt: parseInstant(credential.earliestRefreshAt, now),
      scope: credential.scope,
    };
    return {
      oauthSealed: this.seal(tokens),
      oauthAccount: {
        clientId: credential.clientId,
        subject: claims.sub,
        email: emailOf(claims),
        planType: planTypeOf(claims),
        status: 'connected',
        detail: null,
        signedInAt: new Date(now).toISOString(),
      },
    };
  }

  /** Stores a new sign-in of a provider (after its pending renewals). */
  async store(providerId: string, signedIn: SignedIn): Promise<void> {
    await this.serialize(providerId, async () => {
      await this.db
        .update(providerProfiles)
        .set({ ...signedIn, updatedAt: new Date() })
        .where(eq(providerProfiles.id, providerId));
    });
    this.pausedUntil.delete(providerId);
    this.lastStatus.delete(providerId);
  }

  /** Signing out: OpenAI revokes the refresh token (best effort, the provider goes anyway). */
  async revoke(oauthSealed: string | null, account: OAuthAccount | null): Promise<void> {
    if (!oauthSealed || !account) return;
    try {
      const tokens = this.open(oauthSealed);
      const discovery = await fetch(`${this.options.authUrl}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5_000),
      });
      const endpoint = ((await discovery.json()) as { revocation_endpoint?: unknown })
        .revocation_endpoint;
      if (typeof endpoint !== 'string') return;
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: tokens.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: account.clientId,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The user can still disconnect MowBot in ChatGPT's settings.
    }
  }

  /**
   * A valid access token for the provider, renewed when it is about to expire, or when `failed`
   * (the token a request was refused with) is still the current one.
   */
  async accessToken(providerId: string, failed?: string): Promise<string> {
    return this.serialize(providerId, async () => {
      const [row] = await this.db
        .select()
        .from(providerProfiles)
        .where(eq(providerProfiles.id, providerId));
      const account = row?.oauthAccount;
      if (!row || !account || !row.oauthSealed || account.status === 'needs_sign_in') {
        throw await this.signInError();
      }
      this.lastStatus.set(providerId, account.status);
      const tokens = this.open(row.oauthSealed);
      const now = Date.now();
      if (failed !== undefined) {
        if (tokens.accessToken !== failed) return tokens.accessToken;
      } else {
        const due = tokens.expiresAt - REFRESH_MARGIN_MS <= now;
        const allowed =
          tokens.earliestRefreshAt === null ||
          tokens.earliestRefreshAt <= now ||
          tokens.expiresAt <= now + 30_000;
        if (!due || !allowed) return tokens.accessToken;
      }
      return this.refresh(providerId, account, tokens);
    });
  }

  /** `grant_type=refresh_token`; the rotated refresh token is saved with the new access token. */
  private async refresh(
    providerId: string,
    account: OAuthAccount,
    tokens: Tokens,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.options.authUrl}/api/accounts/oauth/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: account.clientId,
          refresh_token: tokens.refreshToken,
          resource: RESOURCE,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw await this.planError('refreshUnavailable', 503, String((error as Error).message));
    }
    const body: unknown = await response.json().catch(() => null);
    if (TERMINAL_REFRESH_STATUSES.has(response.status)) {
      // The refresh token is no longer usable: drop the tokens, keep the account and its client
      // for the next sign-in.
      const { code } = errorCodeOf(body);
      await this.db
        .update(providerProfiles)
        .set({
          oauthSealed: null,
          oauthAccount: {
            ...account,
            status: 'needs_sign_in',
            detail: code ?? `HTTP ${response.status}`,
          },
          updatedAt: new Date(),
        })
        .where(eq(providerProfiles.id, providerId));
      this.lastStatus.set(providerId, 'needs_sign_in');
      throw await this.signInError();
    }
    if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string') {
      throw await this.planError('refreshUnavailable', 503, `HTTP ${response.status}`);
    }
    const now = Date.now();
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    const next: Tokens = {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === 'string' ? body.refresh_token : tokens.refreshToken,
      idToken: typeof body.id_token === 'string' ? body.id_token : tokens.idToken,
      expiresAt: now + expiresIn * 1000,
      earliestRefreshAt: parseInstant(body.earliest_refresh_at, now),
      scope: typeof body.scope === 'string' && body.scope ? body.scope : tokens.scope,
    };
    // The new ID token comes straight from OpenAI's token endpoint: only read for display.
    let claims: JWTPayload = {};
    if (typeof body.id_token === 'string') {
      try {
        claims = decodeJwt(body.id_token);
      } catch {
        claims = {};
      }
    }
    const granted = scopesOf(next.scope).includes(PLAN_SCOPE);
    const nextAccount: OAuthAccount = {
      ...account,
      email: emailOf(claims) ?? account.email,
      planType: planTypeOf(claims) ?? account.planType,
      ...(granted ? {} : { status: 'needs_sign_in', detail: `${PLAN_SCOPE} not granted` }),
    };
    await this.db
      .update(providerProfiles)
      .set({ oauthSealed: this.seal(next), oauthAccount: nextAccount, updatedAt: new Date() })
      .where(eq(providerProfiles.id, providerId));
    if (!granted) {
      this.lastStatus.set(providerId, 'needs_sign_in');
      throw await this.signInError();
    }
    return next.accessToken;
  }

  /**
   * The `fetch` of the provider's AI SDK model (and of its model list): bearer token, renewal
   * on 401 (once), plan errors turned into clear, non-retried errors so a bot moves on to its
   * next model.
   */
  fetchFor(providerId: string): typeof fetch {
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const responses = new URL(url).pathname.endsWith('/responses');
      // Paused after a usage limit: no inference (the model list still works).
      const paused = this.pausedUntil.get(providerId);
      if (responses && paused !== undefined && paused > Date.now()) {
        throw await this.planError('usageLimit', 429, 'paused', url);
      }
      const body =
        responses && typeof init?.body === 'string' ? planRequestBody(init.body) : init?.body;
      const send = (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${token}`);
        return fetch(input, { ...init, body, headers });
      };
      let token = await this.accessToken(providerId);
      let response = await send(token);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        token = await this.accessToken(providerId, token);
        response = await send(token);
      }
      if (!response.ok) return this.checkFailure(providerId, response, url);
      if (responses && response.headers.get('content-type')?.includes('text/event-stream')) {
        return this.checkStream(providerId, response, url);
      }
      if (responses) await this.working(providerId);
      return response;
    };
  }

  /** A refused request: plan errors become clear errors, the rest goes to the AI SDK as is. */
  private async checkFailure(
    providerId: string,
    response: Response,
    url: string,
  ): Promise<Response> {
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const { code, param } = errorCodeOf(parsed);
    const plan = code ? PLAN_ERRORS[code] : undefined;
    if (code && plan) throw await this.planFailure(providerId, code, param, url);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Reads a stream until its first meaningful event: a plan error sent before any output fails
   * the request (the AI SDK would retry it). The bytes read are replayed to the AI SDK.
   */
  private async checkStream(
    providerId: string,
    response: Response,
    url: string,
  ): Promise<Response> {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const read: Uint8Array[] = [];
    let text = '';
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read.push(value);
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const verdict = streamVerdict(text);
      if (verdict?.code && PLAN_ERRORS[verdict.code]) {
        await reader.cancel().catch(() => {});
        throw await this.planFailure(providerId, verdict.code, verdict.param, url);
      }
      if (verdict) {
        await this.working(providerId);
        break;
      }
      if (size > PEEK_BYTES) break;
    }
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of read) controller.enqueue(chunk);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(replay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /** A plan error: noted on the provider (usage limit: paused a while), as a clear error. */
  private async planFailure(
    providerId: string,
    code: string,
    param: string | null,
    url: string,
  ): Promise<APICallError> {
    const plan = PLAN_ERRORS[code] ?? { kind: 'unavailable' as const, status: 503 };
    if (plan.kind === 'usageLimit') {
      this.pausedUntil.set(providerId, Date.now() + LIMIT_PAUSE_MS);
      await this.setStatus(providerId, 'usage_limited', code);
    }
    return this.planError(plan.kind, plan.status, code, url, param);
  }

  /** The request went through: a provider noted as limited is connected again. */
  private async working(providerId: string): Promise<void> {
    if (this.lastStatus.get(providerId) !== 'usage_limited') return;
    this.pausedUntil.delete(providerId);
    await this.setStatus(providerId, 'connected', null);
  }

  private async setStatus(
    providerId: string,
    status: ChatgptStatus,
    detail: string | null,
  ): Promise<void> {
    this.lastStatus.set(providerId, status);
    await this.serialize(providerId, async () => {
      const [row] = await this.db
        .select({ account: providerProfiles.oauthAccount })
        .from(providerProfiles)
        .where(eq(providerProfiles.id, providerId));
      const account = row?.account;
      if (!account || account.status === 'needs_sign_in' || account.status === status) return;
      await this.db
        .update(providerProfiles)
        .set({ oauthAccount: { ...account, status, detail } })
        .where(eq(providerProfiles.id, providerId));
    });
  }

  /** Not retried by the AI SDK: the runtime moves on to the bot's next model. */
  private async planError(
    kind: PlanError | 'refreshUnavailable',
    statusCode: number,
    code: string,
    url = this.options.apiUrl,
    param: string | null = null,
  ): Promise<APICallError> {
    const texts = TEXTS[await ownerLocale(this.db)];
    const message = kind === 'unsupported' ? texts.unsupported(param) : texts[kind];
    return new APICallError({
      message,
      url,
      requestBodyValues: {},
      statusCode,
      isRetryable: false,
      data: { code, param },
    });
  }

  private async signInError(): Promise<APICallError> {
    const texts = TEXTS[await ownerLocale(this.db)];
    return new APICallError({
      message: texts.signInAgain,
      url: this.options.apiUrl,
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
      data: { code: 'chatgpt_sign_in_required' },
    });
  }

  /** The models of the account (`GET /models`, those with `visibility: "list"`), server order. */
  async listModels(providerId: string): Promise<{ id: string; name?: string }[]> {
    let response: Response;
    try {
      response = await this.fetchFor(providerId)(`${this.options.apiUrl}/models`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (APICallError.isInstance(error)) {
        const code = isRecord(error.data) ? error.data.code : null;
        if (code === 'chatgpt_sign_in_required') {
          throw new HttpProblem(409, 'chatgpt_sign_in_required', error.message);
        }
        throw new HttpProblem(502, 'provider_error', error.message);
      }
      throw new HttpProblem(502, 'provider_unreachable', (error as Error).message);
    }
    if (!response.ok) {
      throw new HttpProblem(502, 'provider_error', `OpenAI answered HTTP ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    const seen = new Set<string>();
    const items: { id: string; name?: string }[] = [];
    for (const model of models) {
      if (!isRecord(model) || model.visibility !== 'list' || typeof model.slug !== 'string') {
        continue;
      }
      if (seen.has(model.slug)) continue;
      seen.add(model.slug);
      items.push({
        id: model.slug,
        ...(typeof model.display_name === 'string' && model.display_name
          ? { name: model.display_name }
          : {}),
      });
    }
    return items;
  }

  /** The AI SDK model: OpenAI Responses, not stored, through `fetchFor`. */
  languageModel(providerId: string, modelId: string): LanguageModel {
    const openai = createOpenAI({
      // The real bearer token is set per request by `fetchFor`.
      apiKey: 'chatgpt-plan',
      baseURL: this.options.apiUrl,
      fetch: this.fetchFor(providerId),
    });
    return wrapLanguageModel({
      model: openai.responses(modelId),
      middleware: {
        transformParams: async ({ params }) => ({
          ...params,
          temperature: undefined,
          topP: undefined,
          maxOutputTokens: undefined,
          providerOptions: {
            ...params.providerOptions,
            openai: {
              ...params.providerOptions?.openai,
              store: false,
              systemMessageMode: 'developer',
            },
          },
        }),
        wrapGenerate: async () => {
          throw new Error('ChatGPT plan usage only streams (stream: true)');
        },
      },
    });
  }

  private seal(tokens: Tokens): string {
    return seal(this.masterKey, TOKENS_PURPOSE, JSON.stringify(tokens));
  }

  private open(sealed: string): Tokens {
    return JSON.parse(open(this.masterKey, TOKENS_PURPOSE, sealed)) as Tokens;
  }

  /** Runs `task` after the provider's previous ones (a rotating refresh token cannot race). */
  private async serialize<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const settled = run.catch(() => {});
    this.queues.set(providerId, settled);
    try {
      return await run;
    } finally {
      if (this.queues.get(providerId) === settled) this.queues.delete(providerId);
    }
  }
}
