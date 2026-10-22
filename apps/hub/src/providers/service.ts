import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_DEFAULT_MODEL,
  type ChatgptSignIn,
  PROVIDER_DEFAULT_URLS,
  type Provider,
  type ProviderCreate,
  type ProviderUpdate,
} from '@mowbot/contract';
import { type LanguageModel, wrapLanguageModel } from 'ai';
import { eq, isNull } from 'drizzle-orm';
import { CHATGPT_DEFAULTS, type ChatgptOptions } from '../config';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { bots, providerProfiles } from '../db/schema';
import { HttpProblem, notFound } from '../http/problems';
import { ChatgptService, type SignedIn } from './chatgpt';

const KEY_PURPOSE = 'provider-api-key';

export type ProviderRow = typeof providerProfiles.$inferSelect;

export function toProvider(row: ProviderRow): Provider {
  const account = row.oauthAccount;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    headers: row.headers,
    hasApiKey: row.apiKeySealed !== null,
    chatgpt: account
      ? {
          email: account.email,
          planType: account.planType,
          status: account.status,
          detail: account.detail,
          signedInAt: account.signedInAt,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Claude models whose refusals Anthropic can rerun on another model within the same request
 * (`fallbacks: "default"`), on its own API.
 */
const REFUSAL_FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

const chatgptOnly = () =>
  new HttpProblem(
    400,
    'chatgpt_only',
    'A ChatGPT sign-in only goes with an openai-chatgpt provider',
  );

/** An `openai-chatgpt` provider has no key, URL or headers to set: OpenAI's, with its tokens. */
function refuseSettings(input: { apiKey?: unknown; baseUrl?: unknown; headers?: unknown }) {
  if (input.apiKey !== undefined || input.baseUrl !== undefined || input.headers !== undefined) {
    throw new HttpProblem(
      400,
      'chatgpt_fixed_settings',
      'A ChatGPT provider has no API key, URL or headers to set',
    );
  }
}

/** LLM endpoints: storage (keys sealed with the master key), model listing, AI SDK models. */
export class ProviderService {
  readonly chatgpt: ChatgptService;

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    chatgptOptions: ChatgptOptions = CHATGPT_DEFAULTS,
  ) {
    this.chatgpt = new ChatgptService(db, masterKey, chatgptOptions);
  }

  async list(): Promise<Provider[]> {
    const rows = await this.db.select().from(providerProfiles).orderBy(providerProfiles.createdAt);
    return rows.map(toProvider);
  }

  async row(id: string): Promise<ProviderRow> {
    const [row] = await this.db.select().from(providerProfiles).where(eq(providerProfiles.id, id));
    if (!row) throw notFound('Provider not found');
    return row;
  }

  /** Creates a provider; the first one is given to bots that have none yet (the Chef). */
  async create(input: ProviderCreate): Promise<Provider> {
    let signedIn: SignedIn | null = null;
    if (input.kind === 'openai-chatgpt') {
      refuseSettings(input);
      if (!input.chatgpt) {
        throw new HttpProblem(
          400,
          'chatgpt_sign_in_required',
          'Sign in with ChatGPT from the desktop app',
        );
      }
      signedIn = await this.chatgpt.accept(input.chatgpt, null);
    } else if (input.chatgpt) {
      throw chatgptOnly();
    }
    const baseUrl =
      input.kind === 'openai-chatgpt'
        ? this.chatgpt.options.apiUrl
        : (input.baseUrl ?? PROVIDER_DEFAULT_URLS[input.kind]);
    if (!baseUrl) throw new HttpProblem(400, 'base_url_required', 'This provider needs a base URL');
    if (input.kind === 'anthropic' && !input.apiKey) {
      throw new HttpProblem(400, 'api_key_required', 'An Anthropic provider needs an API key');
    }
    const defaultModel =
      input.defaultModel ?? (input.kind === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : null);
    const [created] = await this.db
      .insert(providerProfiles)
      .values({
        name: input.name,
        kind: input.kind,
        baseUrl: trimSlash(baseUrl),
        defaultModel,
        headers: input.headers ?? {},
        apiKeySealed: input.apiKey ? seal(this.masterKey, KEY_PURPOSE, input.apiKey) : null,
        ...(signedIn ?? {}),
      })
      .returning();
    if (!created) throw new Error('Provider insert returned no row');
    let row = created;
    if (signedIn && !row.defaultModel) {
      // Bots need a model: the account's first one, when OpenAI lists them.
      const first = await this.chatgpt
        .listModels(row.id)
        .then((models) => models[0]?.id ?? null)
        .catch(() => null);
      if (first) {
        const [updated] = await this.db
          .update(providerProfiles)
          .set({ defaultModel: first })
          .where(eq(providerProfiles.id, row.id))
          .returning();
        if (updated) row = updated;
      }
    }
    await this.db
      .update(bots)
      .set({ providerId: row.id, model: row.defaultModel })
      .where(isNull(bots.providerId));
    return toProvider(row);
  }

  async update(id: string, input: ProviderUpdate): Promise<Provider> {
    const current = await this.row(id);
    if (current.kind === 'openai-chatgpt') {
      refuseSettings(input);
      if (input.chatgpt) {
        // Signed in again: the same account, its renewed tokens replace the old ones.
        const signedIn = await this.chatgpt.accept(input.chatgpt, current.oauthAccount);
        await this.chatgpt.store(id, signedIn);
      }
    } else if (input.chatgpt) {
      throw chatgptOnly();
    }
    const [row] = await this.db
      .update(providerProfiles)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: trimSlash(input.baseUrl) } : {}),
        ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.apiKey !== undefined
          ? { apiKeySealed: seal(this.masterKey, KEY_PURPOSE, input.apiKey) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(providerProfiles.id, id))
      .returning();
    if (!row) throw notFound('Provider not found');
    return toProvider(row);
  }

  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    await this.db.delete(providerProfiles).where(eq(providerProfiles.id, id));
    if (row.kind === 'openai-chatgpt') await this.chatgpt.revoke(row.oauthSealed, row.oauthAccount);
  }

  /** What the desktop app needs to sign in with ChatGPT (again, for `providerId`). */
  async chatgptSignIn(providerId?: string): Promise<ChatgptSignIn> {
    if (!providerId) return this.chatgpt.signInParams(null);
    const row = await this.row(providerId);
    if (row.kind !== 'openai-chatgpt') throw chatgptOnly();
    return this.chatgpt.signInParams(row.oauthAccount);
  }

  private apiKey(row: ProviderRow): string | undefined {
    return row.apiKeySealed ? open(this.masterKey, KEY_PURPOSE, row.apiKeySealed) : undefined;
  }

  /** Models advertised by the endpoint (`GET {baseUrl}/models`, OpenAI format). */
  async listModels(id: string): Promise<{ id: string; name?: string }[]> {
    const row = await this.row(id);
    if (row.kind === 'openai-chatgpt') return this.chatgpt.listModels(row.id);
    if (row.kind === 'anthropic') return this.anthropicModels(row);
    const key = this.apiKey(row);
    let response: Response;
    try {
      response = await fetch(`${row.baseUrl}/models`, {
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...row.headers },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new HttpProblem(502, 'provider_unreachable', (error as Error).message);
    }
    if (!response.ok) {
      throw new HttpProblem(502, 'provider_error', `The provider answered HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = (body?.data ?? [])
      .map((model) => model.id)
      .filter((value): value is string => typeof value === 'string');
    return [...new Set(ids)].sort().map((value) => ({ id: value }));
  }

  /** Claude's models, newest first, with their names (Models API). */
  private async anthropicModels(row: ProviderRow): Promise<{ id: string; name?: string }[]> {
    const client = new Anthropic({
      apiKey: this.apiKey(row),
      // The SDK adds `/v1` itself.
      baseURL: row.baseUrl.replace(/\/v1$/, ''),
      defaultHeaders: row.headers,
      timeout: 15_000,
      maxRetries: 1,
    });
    const models: { id: string; name?: string }[] = [];
    try {
      for await (const model of client.models.list()) {
        models.push({ id: model.id, name: model.display_name });
      }
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status) {
        throw new HttpProblem(502, 'provider_error', `The provider answered HTTP ${error.status}`);
      }
      throw new HttpProblem(502, 'provider_unreachable', (error as Error).message);
    }
    return models;
  }

  /** AI SDK model for a provider row and model id. */
  languageModel(row: ProviderRow, modelId: string): LanguageModel {
    if (row.kind === 'openai-chatgpt') return this.chatgpt.languageModel(row.id, modelId);
    const apiKey = this.apiKey(row);
    if (row.kind === 'anthropic') {
      const anthropic = createAnthropic({ apiKey, baseURL: row.baseUrl, headers: row.headers });
      const official = row.baseUrl === PROVIDER_DEFAULT_URLS.anthropic;
      return wrapLanguageModel({
        model: anthropic(modelId),
        middleware: {
          transformParams: async ({ params }) => ({
            ...params,
            providerOptions: {
              ...params.providerOptions,
              anthropic: {
                // The tools, the system prompt and the conversation come again at each step:
                // cached, they cost a tenth.
                cacheControl: { type: 'ephemeral' },
                // A refused request is rerun on another Claude model instead of stopping.
                ...(official && REFUSAL_FALLBACK_MODELS.test(modelId)
                  ? { fallbacks: 'default' as const }
                  : {}),
                ...params.providerOptions?.anthropic,
              },
            },
          }),
        },
      });
    }
    if (row.kind === 'openai') {
      return wrapLanguageModel({
        model: createOpenAI({ apiKey, baseURL: row.baseUrl, headers: row.headers }).responses(
          modelId,
        ),
        middleware: {
          transformParams: async ({ params }) => ({
            ...params,
            providerOptions: {
              ...params.providerOptions,
              openai: {
                // What a reasoning model thinks about, in short: the apps show it while it
                // thinks (dropped for the other models).
                reasoningSummary: 'auto',
                ...params.providerOptions?.openai,
              },
            },
          }),
        },
      });
    }
    return createOpenAICompatible({
      name: row.kind === 'command-code' ? 'command-code' : `provider-${row.id.slice(0, 8)}`,
      baseURL: row.baseUrl,
      apiKey,
      headers: row.headers,
    }).chatModel(modelId);
  }
}
