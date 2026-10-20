import { z } from 'zod';

/** `command-code` is an OpenAI-compatible endpoint preset; `openai` uses the Responses API. */
export const providerKindSchema = z.enum(['openai-compatible', 'command-code', 'openai']);
export type ProviderKind = z.infer<typeof providerKindSchema>;

export const PROVIDER_DEFAULT_URLS: Partial<Record<ProviderKind, string>> = {
  'command-code': 'https://api.commandcode.ai/provider/v1',
  openai: 'https://api.openai.com/v1',
};

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

export const providerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: providerKindSchema,
  baseUrl: z.string(),
  defaultModel: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  /** Keys are write-only: the API never returns them. */
  hasApiKey: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type Provider = z.infer<typeof providerSchema>;

export const providerListSchema = z.object({ items: z.array(providerSchema) });

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: providerKindSchema,
  /** Required for `openai-compatible`, defaulted for the presets. */
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(1000).optional(),
  defaultModel: z.string().trim().min(1).max(200).optional(),
  headers: providerHeadersSchema.optional(),
});
export type ProviderCreate = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  baseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(1000).optional(),
  defaultModel: z.string().trim().min(1).max(200).nullable().optional(),
  /** Replaces all the headers. */
  headers: providerHeadersSchema.optional(),
});
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>;

export const providerIdParamsSchema = z.object({ id: z.uuid() });

export const modelListSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
});
export type ModelList = z.infer<typeof modelListSchema>;
