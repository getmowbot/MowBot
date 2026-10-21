import { z } from 'zod';

import { computerStatusSchema } from './computers';

/**
 * MCP servers: tools from elsewhere for the bots. `http`: a remote server (Streamable HTTP,
 * SSE for older ones), reached by the hub; `stdio`: a program run on the MCP computer (or, for
 * servers a bot installed before, on that bot's computer).
 */
export const mcpTransportSchema = z.enum(['http', 'stdio']);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** `oauth`: the hub signs in to the server for the user (they approve once in their browser). */
export const mcpAuthSchema = z.enum(['none', 'oauth']);
export type McpAuth = z.infer<typeof mcpAuthSchema>;

/** Which bots get the server's tools. */
export const mcpScopeSchema = z.object({
  kind: z.enum(['all', 'teams', 'bots']),
  /** Team or bot ids (empty for `all`). */
  ids: z.array(z.uuid()).max(100),
});
export type McpScope = z.infer<typeof mcpScopeSchema>;

export const mcpStatusSchema = z.enum(['unknown', 'ok', 'error', 'needs_auth']);
export type McpStatus = z.infer<typeof mcpStatusSchema>;

export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** The server says it only reads, or that it may destroy (annotations). */
  readOnly: z.boolean().nullable(),
  destructive: z.boolean().nullable(),
});
export type McpTool = z.infer<typeof mcpToolSchema>;

export const mcpServerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Prefix of its tools for the bots: `mcp__<slug>__<tool>`. */
  slug: z.string(),
  transport: mcpTransportSchema,
  url: z.string().nullable(),
  command: z.string().nullable(),
  auth: mcpAuthSchema,
  /** Names of the headers (http) or environment variables (stdio) set; values never come back. */
  secretKeys: z.array(z.string()),
  scope: mcpScopeSchema,
  /**
   * A local server installed by a bot on this computer before the MCP computer existed: it runs
   * there and only the bots of that computer use it (`move` puts it on the MCP computer). Null:
   * a local server runs on the MCP computer.
   */
  computerId: z.uuid().nullable(),
  createdByBotId: z.uuid().nullable(),
  enabled: z.boolean(),
  status: mcpStatusSchema,
  /** Why it is in error (the server's or the transport's words). */
  statusDetail: z.string().nullable(),
  tools: z.array(mcpToolSchema),
  toolsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpServerListSchema = z.object({ items: z.array(mcpServerSchema) });
export const mcpServerIdParamsSchema = z.object({ id: z.uuid() });

const secretsSchema = z.record(z.string().min(1).max(100), z.string().max(10_000));

export const mcpServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  transport: mcpTransportSchema,
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_000)
    .optional(),
  command: z.string().trim().min(1).max(2_000).optional(),
  auth: mcpAuthSchema.default('none'),
  /** Headers (http, e.g. Authorization) or environment variables (stdio), write-only. */
  secrets: secretsSchema.optional(),
  scope: mcpScopeSchema.default({ kind: 'all', ids: [] }),
});
export type McpServerCreate = z.infer<typeof mcpServerCreateSchema>;

export const mcpServerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2_000)
    .optional(),
  command: z.string().trim().min(1).max(2_000).optional(),
  auth: mcpAuthSchema.optional(),
  /** Replaces the given keys; null removes one. */
  secrets: z.record(z.string().min(1).max(100), z.string().max(10_000).nullable()).optional(),
  scope: mcpScopeSchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdate = z.infer<typeof mcpServerUpdateSchema>;

/** Starts signing in to an OAuth server; the callback lands on `<redirectBase>/api/v1/mcp/oauth/callback`. */
export const mcpOAuthStartSchema = z.object({ redirectBase: z.url({ protocol: /^https?$/ }) });
export const mcpOAuthStartResultSchema = z.object({
  /** Where to send the user's browser (null: already signed in). */
  authorizationUrl: z.string().nullable(),
});

/** The computer local (stdio) servers run on: started when a server is needed, asleep when idle. */
export const mcpComputerSchema = z.object({
  /** Null until it is first needed. */
  id: z.uuid().nullable(),
  status: computerStatusSchema,
  statusDetail: z.string().nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
});
export type McpComputer = z.infer<typeof mcpComputerSchema>;

export const mcpCallSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  botId: z.uuid().nullable(),
  tool: z.string(),
  ok: z.boolean(),
  durationMs: z.number().int(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type McpCall = z.infer<typeof mcpCallSchema>;
export const mcpCallListSchema = z.object({ items: z.array(mcpCallSchema) });
