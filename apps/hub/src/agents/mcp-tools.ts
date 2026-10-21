import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jsonSchema, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { Db } from '../db/client';
import type { StoredMcpTool } from '../db/schema';
import { type McpServerRow, type McpService, textOf } from '../mcp/service';
import { buildMcpAdminTools } from './mcp-admin-tools';

/** Up to this many MCP tools, each is a tool of its own; past it, bots search them. */
export const DIRECT_MCP_TOOLS = 40;

/** What a bot reads of one result at most. */
export const MCP_RESULT_CHARS = 48_000;

/** `mcp__<server>__<tool>`, within the length and characters models accept. */
export const mcpToolName = (server: McpServerRow, name: string) =>
  `mcp__${server.slug}__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);

/**
 * Keeps the beginning of a long result (a listing's first items, a document's start) and says
 * what is missing, so the bot asks for less at a time instead of working around the tool.
 */
export function clipResult(text: string, max = MCP_RESULT_CHARS): string {
  if (text.length <= max) return text;
  // At a line break near the limit, when there is one, not in the middle of an item.
  const newline = text.lastIndexOf('\n', max);
  const end = newline > max * 0.8 ? newline : max;
  return `${text.slice(0, end)}\n\n[Résultat coupé : seuls les ${end} premiers caractères sur ${text.length} sont affichés. Demande moins à la fois (une page plus petite, un filtre, une recherche plus précise) si l'outil le permet.]`;
}

/** What the model reads of a tool's result; pictures go to its next step. */
export function formatResult(result: CallToolResult, pendingImages: string[]): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') parts.push(part.text);
    else if (part.type === 'image') {
      pendingImages.push(part.data);
      parts.push('[image jointe au message suivant]');
    } else if (part.type === 'resource') {
      parts.push('text' in part.resource ? part.resource.text : `[ressource ${part.resource.uri}]`);
    } else if (part.type === 'resource_link') {
      parts.push(`[${part.name} : ${part.uri}]`);
    } else if (part.type === 'audio') {
      parts.push('[audio]');
    }
  }
  if (parts.length === 0 && result.structuredContent) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return clipResult(parts.join('\n\n') || '(aucun résultat)');
}

const describeTool = (server: McpServerRow, entry: StoredMcpTool) =>
  `[${server.name}] ${entry.description ?? entry.name}${entry.destructive ? ' (peut modifier ou supprimer des données)' : ''}`;

/**
 * Tools of the MCP servers the bot is given, as tools of its own (or searched, when there are
 * many); for the Chef, also managing the servers.
 */
export async function buildMcpTools(ctx: {
  self: BotRow;
  mcp: McpService;
  db: Db;
  pendingImages: string[];
  /** Fills in `{{vault:…}}` placeholders (the Chef's secrets and setup commands). */
  expand(text: string): Promise<string>;
}): Promise<ToolSet> {
  const { self, mcp, pendingImages } = ctx;
  const tools: ToolSet = {};
  const servers = await mcp.accessibleTo(self);
  // Remote servers never listed yet: try once, quickly (local ones wait for a first use).
  for (const [index, server] of servers.entries()) {
    if (server.toolsAt || server.transport !== 'http' || server.status === 'needs_auth') continue;
    const listed = await mcp.refresh(server.id).catch(() => null);
    if (listed) servers[index] = listed;
  }
  const usable = servers.filter((server) => server.status !== 'needs_auth');

  const call = async (server: McpServerRow, name: string, args: Record<string, unknown>) => {
    const result = await mcp.call(server, self, name, args);
    if (result.isError) {
      throw new Error(mcp.mask(server, clipResult(textOf(result), 4_000)) || `${name} a échoué`);
    }
    return mcp.mask(server, formatResult(result, pendingImages));
  };

  const total = usable.reduce((sum, server) => sum + server.tools.length, 0);
  if (total <= DIRECT_MCP_TOOLS) {
    for (const server of usable) {
      for (const entry of server.tools) {
        tools[mcpToolName(server, entry.name)] = tool({
          description: describeTool(server, entry),
          inputSchema: jsonSchema({ type: 'object', properties: {}, ...entry.inputSchema }),
          execute: async (args) => call(server, entry.name, args as Record<string, unknown>),
        });
      }
    }
  }

  const find = (ref: string) => {
    const value = ref.trim().toLowerCase();
    const server = usable.find(
      (s) => s.slug === value || s.name.toLowerCase() === value || s.id === ref.trim(),
    );
    if (!server) throw new Error(`Aucun serveur MCP « ${ref} » (mcp_search_tools).`);
    return server;
  };

  // The Chef can add a server during the turn: reachable at once with mcp_call.
  if (usable.length > 0 || self.isChef) {
    tools.mcp_search_tools = tool({
      description:
        'Cherche parmi les outils des serveurs MCP qui te sont donnés (nom, description, paramètres), pour les appeler ensuite avec mcp_call.',
      inputSchema: z.object({
        query: z.string().max(100).optional().describe('Mots-clés ; vide pour tout lister'),
        server: z.string().max(60).optional(),
      }),
      execute: async ({ query, server }) => {
        const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        for (const s of server ? [find(server)] : usable) {
          for (const entry of s.tools) {
            const haystack = `${entry.name} ${entry.description ?? ''}`.toLowerCase();
            if (words.length && !words.every((word) => haystack.includes(word))) continue;
            lines.push(
              `- ${s.slug} · ${entry.name} : ${entry.description ?? ''}\n  paramètres : ${JSON.stringify(entry.inputSchema.properties ?? {})}`,
            );
          }
        }
        return lines.slice(0, 30).join('\n') || 'Aucun outil ne correspond.';
      },
    });

    tools.mcp_call = tool({
      description:
        "Appelle un outil d'un serveur MCP qui t'est donné (voir mcp_search_tools), avec ses paramètres.",
      inputSchema: z.object({
        server: z.string().describe('Nom ou identifiant (slug) du serveur'),
        tool: z.string(),
        arguments: z.record(z.string(), z.unknown()).default({}),
      }),
      execute: async ({ server, tool: name, arguments: args }) => call(find(server), name, args),
    });
  }

  if (self.isChef) {
    Object.assign(
      tools,
      buildMcpAdminTools({
        self,
        mcp,
        db: ctx.db,
        expand: ctx.expand,
        // What the Chef changes is usable during the same turn (mcp_call).
        changed: (row) => {
          const index = usable.findIndex((s) => s.id === row.id);
          const keep = mcp.canUse(row, self) && row.status !== 'needs_auth';
          if (index >= 0 && keep) usable[index] = row;
          else if (index >= 0) usable.splice(index, 1);
          else if (keep) usable.push(row);
        },
      }),
    );
  }

  return tools;
}
