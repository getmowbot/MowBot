import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  PROVIDER_DEFAULT_URLS,
  type Provider,
  type ProviderCreate,
  type ProviderUpdate,
} from '@mowbot/contract';
import type { LanguageModel } from 'ai';
import { eq, isNull } from 'drizzle-orm';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { bots, providerProfiles } from '../db/schema';
import { HttpProblem, notFound } from '../http/problems';

const KEY_PURPOSE = 'provider-api-key';

export type ProviderRow = typeof providerProfiles.$inferSelect;

export function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    headers: row.headers,
    hasApiKey: row.apiKeySealed !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** LLM endpoints: storage (keys sealed with the master key), model listing, AI SDK models. */
export class ProviderService {
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
  ) {}

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
    const baseUrl = input.baseUrl ?? PROVIDER_DEFAULT_URLS[input.kind];
    if (!baseUrl) throw new HttpProblem(400, 'base_url_required', 'This provider needs a base URL');
    const [row] = await this.db
      .insert(providerProfiles)
      .values({
        name: input.name,
        kind: input.kind,
        baseUrl: trimSlash(baseUrl),
        defaultModel: input.defaultModel ?? null,
        headers: input.headers ?? {},
        apiKeySealed: input.apiKey ? seal(this.masterKey, KEY_PURPOSE, input.apiKey) : null,
      })
      .returning();
    if (!row) throw new Error('Provider insert returned no row');
    await this.db
      .update(bots)
      .set({ providerId: row.id, model: row.defaultModel })
      .where(isNull(bots.providerId));
    return toProvider(row);
  }

  async update(id: string, input: ProviderUpdate): Promise<Provider> {
    await this.row(id);
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
    await this.row(id);
    await this.db.delete(providerProfiles).where(eq(providerProfiles.id, id));
  }

  private apiKey(row: ProviderRow): string | undefined {
    return row.apiKeySealed ? open(this.masterKey, KEY_PURPOSE, row.apiKeySealed) : undefined;
  }

  /** Models advertised by the endpoint (`GET {baseUrl}/models`, OpenAI format). */
  async listModels(id: string): Promise<{ id: string }[]> {
    const row = await this.row(id);
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

  /** AI SDK model for a provider row and model id. */
  languageModel(row: ProviderRow, modelId: string): LanguageModel {
    const apiKey = this.apiKey(row);
    if (row.kind === 'openai') {
      return createOpenAI({ apiKey, baseURL: row.baseUrl, headers: row.headers }).responses(
        modelId,
      );
    }
    return createOpenAICompatible({
      name: row.kind === 'command-code' ? 'command-code' : `provider-${row.id.slice(0, 8)}`,
      baseURL: row.baseUrl,
      apiKey,
      headers: row.headers,
    }).chatModel(modelId);
  }
}
