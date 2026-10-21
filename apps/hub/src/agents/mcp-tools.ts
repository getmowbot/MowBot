import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jsonSchema, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { StoredMcpTool } from '../db/schema';
import { type McpServerRow, type McpService, textOf } from '../mcp/service';
import { clip } from './tools';

/** Up to this many MCP tools, each is a tool of its own; past it, bots search them. */
export const DIRECT_MCP_TOOLS = 40;

/** `mcp__<server>__<tool>`, within the length and characters models accept. */
export const mcpToolName = (server: McpServerRow, name: string) =>
  `mcp__${server.slug}__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);

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
  return clip(parts.join('\n\n') || '(aucun résultat)');
}

const describeTool = (server: McpServerRow, entry: StoredMcpTool) =>
  `[${server.name}] ${entry.description ?? entry.name}${entry.destructive ? ' (peut modifier ou supprimer des données)' : ''}`;

/**
 * Tools of the MCP servers the bot is given, as tools of its own (or searched, when there are
 * many), plus installing a local server on its computer.
 */
export async function buildMcpTools(ctx: {
  self: BotRow;
  mcp: McpService;
  pendingImages: string[];
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
    if (result.isError) throw new Error(textOf(result) || `${name} a échoué`);
    return formatResult(result, pendingImages);
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

  // With a computer, a server installed during the turn is reachable at once.
  if (usable.length > 0 || self.computerId) {
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

  if (!self.computerId) return tools;
  const computerId = self.computerId;

  tools.mcp_add_local = tool({
    description:
      "Installe un serveur MCP local (stdio) sur ton PC, pour toi et les bots du même PC : la commande qui le lance (ex. « npx -y @modelcontextprotocol/server-sqlite --db-path /workspace/data.db »), et ses variables d'environnement. Ses outils sont à toi dès ton prochain tour ; d'ici là, appelle-les avec mcp_call.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(60),
      command: z.string().trim().min(1).max(2_000),
      env: z.record(z.string().min(1).max(100), z.string().max(10_000)).optional(),
    }),
    execute: async ({ name, command, env }) => {
      const row = await mcp.create(
        {
          name,
          transport: 'stdio',
          command,
          auth: 'none',
          secrets: env,
          scope: { kind: 'all', ids: [] },
        },
        { botId: self.id, computerId },
      );
      try {
        const listed = await mcp.refresh(row.id, computerId);
        usable.push(listed);
        return `Serveur MCP « ${listed.name} » (${listed.slug}) installé : ${listed.tools.map((t) => t.name).join(', ') || 'aucun outil'}.`;
      } catch (error) {
        throw new Error(
          `Le serveur ne démarre pas : ${(error as Error).message}. Corrige la commande (mcp_remove_local puis mcp_add_local).`,
        );
      }
    },
  });

  tools.mcp_remove_local = tool({
    description: 'Retire un serveur MCP local que tu as installé.',
    inputSchema: z.object({ server: z.string().min(1) }),
    execute: async ({ server }) => {
      const mine = await mcp.installedBy(self.id);
      const value = server.trim().toLowerCase();
      const row = mine.find((s) => s.slug === value || s.name.toLowerCase() === value);
      if (!row) throw new Error(`Tu n'as pas installé de serveur « ${server} ».`);
      await mcp.remove(row.id);
      return `Serveur MCP « ${row.name} » retiré.`;
    },
  });

  return tools;
}
