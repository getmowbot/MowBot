import { z } from 'zod';

/**
 * `command-code` is an OpenAI-compatible endpoint preset; `openai` uses the Responses API with an
 * API key; `openai-chatgpt` uses it with the user's ChatGPT plan ("Sign in with ChatGPT", done in
 * the desktop app, see docs/DESKTOP.md).
 */
export const providerKindSchema = z.enum([
  'openai-compatible',
  'command-code',
  'openai',
  'openai-chatgpt',
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const PROVIDER_DEFAULT_URLS: Partial<Record<ProviderKind, string>> = {
  'command-code': 'https://api.commandcode.ai/provider/v1',
  openai: 'https://api.openai.com/v1',
  'openai-chatgpt': 'https://api.openai.com/v1',
};

/** Where the user follows and manages the usage of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Extra HTTP headers sent with every request to the provider (e.g. `x-cmd-zdr: 1`). */
export const providerHeadersSchema = z
  .record(
    z.string().regex(HEADER_NAME, 'Invalid header name').max(100),
    z
      .string()
      .regex(/^[^\r\n]*$/, 'Header values are single-line')
      .max(2000),
  )
  .refine((headers) => Object.keys(headers).length <= 20, 'At most 20 headers');
export type ProviderHeaders = z.infer<typeof providerHeadersSchema>;

/**
 * `connected`: the hub holds a working session. `needs_sign_in`: OpenAI refused to renew it (or
 * the plan is no longer granted): sign in again from the desktop app. `usage_limited`: the last
 * request hit a usage limit of the plan (or of the app), bots use their fallback models meanwhile.
 */
export const chatgptStatusSchema = z.enum(['connected', 'needs_sign_in', 'usage_limited']);
export type ChatgptStatus = z.infer<typeof chatgptStatusSchema>;

/** The ChatGPT account behind an `openai-chatgpt` provider. Never any token. */
export const chatgptAccountSchema = z.object({
  email: z.string().nullable(),
  /** `plus`, `pro`… when OpenAI says it. */
  planType: z.string().nullable(),
  status: chatgptStatusSchema,
  /** Why the status (the error OpenAI gave), for support. */
  detail: z.string().nullable(),
  signedInAt: z.iso.datetime(),
});
export type ChatgptAccount = z.infer<typeof chatgptAccountSchema>;

export const providerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: providerKindSchema,
  baseUrl: z.string(),
  defaultModel: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  /** Keys are write-only: the API never returns them. */
  hasApiKey: z.boolean(),
  /** `openai-chatgpt` only: the signed-in account and the state of its session. */
  chatgpt: chatgptAccountSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerListSchema = z.object({ items: z.array(providerSchema) });

/**
 * What the desktop app got from OpenAI at the end of "Sign in with ChatGPT". Sent once to the
 * hub, which checks the ID token, seals the tokens and never returns them.
 */
export const chatgptCredentialSchema = z.object({
  /** The client OpenAI issued (`oaiapp_…`), never `dynamic_agent_client`. */
  clientId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]+$/)
    .max(200),
  idToken: z.string().min(1).max(20_000),
  accessToken: z.string().min(1).max(20_000),
  refreshToken: z.string().min(1).max(20_000),
  /** Seconds, from the token response. */
  expiresIn: z.number().int().positive().max(31_536_000),
  /** Granted scopes, space-separated. */
  scope: z.string().max(2000),
  /** The sign-in's nonce, checked against the ID token. */
  nonce: z.string().min(1).max(200),
  /** `earliest_refresh_at` of the token response, as OpenAI gave it. */
  earliestRefreshAt: z
    .union([z.number(), z.string().max(100)])
    .nullable()
    .optional(),
});
export type ChatgptCredential = z.infer<typeof chatgptCredentialSchema>;

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: providerKindSchema,
  /** Required for `openai-compatible`, defaulted for the presets (fixed for `openai-chatgpt`). */
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(1000).optional(),
  defaultModel: z.string().trim().min(1).max(200).optional(),
  headers: providerHeadersSchema.optional(),
  /** Required for `openai-chatgpt` (and only for it). */
  chatgpt: chatgptCredentialSchema.optional(),
});
export type ProviderCreate = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(1000).optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  /** Replaces all the headers. */
  headers: providerHeadersSchema.optional(),
  /** `openai-chatgpt`: signed in again, with the same ChatGPT account. */
  chatgpt: chatgptCredentialSchema.optional(),
});
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

export const providerIdParamsSchema = z.object({ id: z.uuid() });

export const chatgptSignInQuerySchema = z.object({
  /** Signing in again to this provider (its client and account are reused). */
  providerId: z.uuid().optional(),
});

/** What the desktop app needs to start "Sign in with ChatGPT" for this hub. */
export const chatgptSignInSchema = z.object({
  /** `ext_agent_host_id`: this hub, where the tokens are used. Stable for the install. */
  hostId: z.string(),
  /** `agent_name_hint`, for a new registration. */
  agentName: z.string(),
  /** The issued client to sign in again with (null: a new registration). */
  clientId: z.string().nullable(),
  /** The account's email, as `login_hint` when signing in again. */
  loginHint: z.string().nullable(),
});
export type ChatgptSignIn = z.infer<typeof chatgptSignInSchema>;

export const modelListSchema = z.object({
  /** `name`: what to show, when the endpoint has a display name (`id` is what bots use). */
  items: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
export type ModelList = z.infer<typeof modelListSchema>;
