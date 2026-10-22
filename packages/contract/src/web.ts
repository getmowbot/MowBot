import { z } from 'zod';

/**
 * Where the bots' web searches go, from the hub (no computer needed). `duckduckgo`: free, no
 * key; `brave` (Brave Search API) and `tavily` take an API key.
 */
export const webSearchProviderSchema = z.enum(['duckduckgo', 'brave', 'tavily']);
export type WebSearchProvider = z.infer<typeof webSearchProviderSchema>;

export const webSearchSettingsSchema = z.object({
  provider: webSearchProviderSchema,
  /** A key is saved (it never comes back). */
  hasKey: z.boolean(),
});
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>;

export const webSearchUpdateSchema = z.object({
  provider: webSearchProviderSchema,
  /** The provider's key; null: remove it; omitted: keep it. */
  apiKey: z.string().trim().min(8).max(500).nullable().optional(),
});
export type WebSearchUpdate = z.infer<typeof webSearchUpdateSchema>;
