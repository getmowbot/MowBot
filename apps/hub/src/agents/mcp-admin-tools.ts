import type { McpScope, McpServerUpdate } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { Db } from '../db/client';
import { bots, computers, teams } from '../db/schema';
import { type McpServerRow, type McpService, maskValues } from '../mcp/service';
import { clip } from './tools';

const intentSchema = z
  .string()
  .max(80)
  .optional()
  .describe(
    "Ce que tu fais, en quelques mots, pour l'utilisateur (ex. « Installe le serveur Apple Music »)",
  );

const secretsSchema = z.record(z.string().min(1).max(100), z.string().max(10_000));
const secretsPatchSchema = z.record(z.string().min(1).max(100), z.string().max(10_000).nullable());

const scopeSchema = z
  .object({
    kind: z.enum(['all', 'teams', 'bots']),
    names: z
      .array(z.string().min(1).max(100))
      .max(50)
      .default([])
      .describe('Les équipes ou les bots (noms ou identifiants) ; vide pour all'),
  })
  .describe('Qui reçoit ses outils : tous les bots, des équipes, ou des bots');

const SECRETS_HINT =
  'Valeurs chiffrées, jamais réaffichées ; mets-y de préférence un placeholder du coffre ({{vault:ref.value}}).';

const STATUS_TEXT: Record<McpServerRow['status'], string> = {
  ok: 'OK',
  error: 'en erreur',
  needs_auth: "connexion OAuth à faire par l'utilisateur (page MCP de l'app)",
  unknown: 'pas encore joint',
};

const COMPUTER_TEXT = {
  stopped: 'en veille',
  starting: 'démarre',
  running: 'allumé',
  stopping: 'se met en veille',
  error: 'en erreur',
} as const;

/**
 * The Chef manages the MCP servers: lists, adds (remote, or local on the MCP computer), changes
 * and removes them, and runs setup commands on the MCP computer. Secrets stay write-only.
 */
export function buildMcpAdminTools(ctx: {
  self: BotRow;
  mcp: McpService;
  db: Db;
  expand(text: string): Promise<string>;
  /** A server added, changed or removed during the turn. */
  changed(row: McpServerRow): void;
}): ToolSet {
  const { self, mcp, db, expand, changed } = ctx;
  const tools: ToolSet = {};

  const directory = async () => {
    const [teamRows, botRows, pcRows] = await Promise.all([
      db.select({ id: teams.id, name: teams.name }).from(teams),
      db.select({ id: bots.id, name: bots.name }).from(bots),
      db.select({ id: computers.id, name: computers.name }).from(computers),
    ]);
    return { teams: teamRows, bots: botRows, computers: pcRows };
  };

  const scopeOf = async (input: z.infer<typeof scopeSchema>): Promise<McpScope> => {
    if (input.kind === 'all') return { kind: 'all', ids: [] };
    const { teams: teamRows, bots: botRows } = await directory();
    const candidates = input.kind === 'teams' ? teamRows : botRows;
    const ids = input.names.map((name) => {
      const value = name.trim().toLowerCase();
      const found = candidates.find((c) => c.id === name.trim() || c.name.toLowerCase() === value);
      if (!found) {
        throw new Error(
          `${input.kind === 'teams' ? 'Aucune équipe' : 'Aucun bot'} « ${name} » (list_bots).`,
        );
      }
      return found.id;
    });
    if (ids.length === 0) throw new Error('Nomme au moins une équipe ou un bot (ou kind: all).');
    return { kind: input.kind, ids: [...new Set(ids)] };
  };

  const findServer = async (ref: string) => {
    const value = ref.trim().toLowerCase();
    const row = (await mcp.list()).find(
      (s) => s.id === ref.trim() || s.slug === value || s.name.toLowerCase() === value,
    );
    if (!row) throw new Error(`Aucun serveur MCP « ${ref} » (mcp_list).`);
    return row;
  };

  const expandAll = async <T extends string | null>(values: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(values)) {
      out[key] = (value === null ? null : await expand(value)) as T;
    }
    return out;
  };

  const describe = async (row: McpServerRow) => {
    const { teams: teamRows, bots: botRows, computers: pcRows } = await directory();
    const nameOf = (list: { id: string; name: string }[], id: string) =>
      list.find((entry) => entry.id === id)?.name ?? '(supprimé)';
    const where =
      row.transport === 'http'
        ? `distant, ${row.url}${row.auth === 'oauth' ? ' (OAuth)' : ''}`
        : row.computerId
          ? `local, sur ${nameOf(pcRows, row.computerId)} (ancien : à déplacer sur le PC MCP)`
          : 'local, PC MCP';
    const scope =
      row.scope.kind === 'all'
        ? 'tous les bots'
        : `${row.scope.kind === 'teams' ? 'équipes' : 'bots'} : ${row.scope.ids
            .map((id) => nameOf(row.scope.kind === 'teams' ? teamRows : botRows, id))
            .join(', ')}`;
    const status = row.enabled
      ? `${STATUS_TEXT[row.status]}${row.status === 'error' && row.statusDetail ? ` (${row.statusDetail})` : ''}`
      : 'désactivé';
    return [
      `- ${row.name} (${row.slug}) · ${where} · ${status} · ${row.tools.length} outil${row.tools.length > 1 ? 's' : ''} · ${scope}`,
      row.command ? `  commande : ${row.command}` : '',
      row.secretKeys.length
        ? `  ${row.transport === 'http' ? 'en-têtes' : 'variables'} secrets : ${row.secretKeys.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  /** Connects and lists the tools; a failure says what to do next. */
  const connect = async (row: McpServerRow, verb: string): Promise<string> => {
    if (!row.enabled) {
      changed(row);
      return `Serveur MCP « ${row.name} » ${verb} (désactivé).`;
    }
    if (row.auth === 'oauth' && row.status !== 'ok') {
      changed(row);
      return `Serveur MCP « ${row.name} » ${verb}. Il demande une connexion OAuth : dis à l'utilisateur de cliquer sur « Se connecter » dans la page MCP de l'app ; ses outils viendront ensuite.`;
    }
    try {
      const listed = await mcp.refresh(row.id);
      changed(listed);
      const names = listed.tools.map((t) => t.name);
      return `Serveur MCP « ${listed.name} » (${listed.slug}) ${verb} : ${names.length} outil${names.length > 1 ? 's' : ''}${names.length ? ` (${names.slice(0, 40).join(', ')}${names.length > 40 ? '…' : ''})` : ''}. Les bots concernés les ont dès leur prochain tour ; toi, tu peux déjà les appeler avec mcp_call.`;
    } catch (error) {
      changed(await mcp.row(row.id));
      throw new Error(
        `Serveur MCP « ${row.name} » ${verb}, mais il ne répond pas : ${(error as Error).message}\nCorrige-le avec mcp_update (commande, url, secrets), installe ce qui manque avec mcp_setup, ou retire-le avec mcp_remove.`,
      );
    }
  };

  tools.mcp_list = tool({
    description:
      "Les serveurs MCP de l'organisation : où chacun tourne, son état, ses outils, qui les reçoit, les noms de ses secrets (jamais les valeurs) ; et l'état du PC MCP.",
    inputSchema: z.object({}),
    execute: async () => {
      const [rows, pc] = await Promise.all([mcp.list(), mcp.computerState()]);
      const lines = await Promise.all(rows.map(describe));
      return [
        `PC MCP : ${COMPUTER_TEXT[pc.status]}${pc.status === 'error' && pc.statusDetail ? ` (${pc.statusDetail})` : ''}.`,
        lines.length ? lines.join('\n') : 'Aucun serveur MCP pour l’instant.',
      ].join('\n');
    },
  });

  tools.mcp_add = tool({
    description:
      "Ajoute un serveur MCP pour les bots. Distant : son url (et ses en-têtes secrets, ex. Authorization). Local : la commande qui le lance sur le PC MCP (ex. « npx -y @modelcontextprotocol/server-github », « uvx mcp-server-fetch », ou un programme installé avant avec mcp_setup), et ses variables d'environnement secrètes. Le hub le joint et liste ses outils.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(60),
      url: z
        .url({ protocol: /^https?$/ })
        .max(2_000)
        .optional()
        .describe('Serveur distant (Streamable HTTP ou SSE)'),
      headers: secretsSchema.optional().describe(`En-têtes du serveur distant. ${SECRETS_HINT}`),
      oauth: z
        .boolean()
        .optional()
        .describe(
          "Le serveur distant demande une connexion OAuth (l'utilisateur la fait dans l'app)",
        ),
      command: z
        .string()
        .trim()
        .min(1)
        .max(2_000)
        .optional()
        .describe('Serveur local : la commande, lancée sur le PC MCP'),
      env: secretsSchema
        .optional()
        .describe(`Variables d'environnement du serveur local. ${SECRETS_HINT}`),
      scope: scopeSchema.optional(),
    }),
    execute: async ({ name, url, headers, oauth, command, env, scope }) => {
      if (Boolean(url) === Boolean(command)) {
        throw new Error('Donne soit url (serveur distant), soit command (serveur local).');
      }
      if (url && env) throw new Error('env est pour un serveur local ; un distant prend headers.');
      if (command && (headers || oauth)) {
        throw new Error('headers et oauth sont pour un serveur distant ; un local prend env.');
      }
      const secrets = await expandAll((url ? headers : env) ?? {});
      const row = await mcp.create(
        {
          name,
          transport: url ? 'http' : 'stdio',
          url,
          command,
          auth: oauth ? 'oauth' : 'none',
          secrets,
          scope: scope ? await scopeOf(scope) : { kind: 'all', ids: [] },
        },
        { botId: self.id },
      );
      return connect(row, 'ajouté');
    },
  });

  tools.mcp_update = tool({
    description:
      "Change un serveur MCP : nom, url ou commande, secrets (une valeur null en retire un), qui le reçoit, activé ou non ; move_to_mcp_pc déplace sur le PC MCP un serveur qu'un bot avait installé sur son propre PC. Sans autre champ, le reconnecte et relit ses outils.",
    inputSchema: z.object({
      server: z.string().min(1).describe('Nom, slug ou identifiant du serveur'),
      name: z.string().trim().min(1).max(60).optional(),
      url: z
        .url({ protocol: /^https?$/ })
        .max(2_000)
        .optional(),
      command: z.string().trim().min(1).max(2_000).optional(),
      headers: secretsPatchSchema
        .optional()
        .describe(`En-têtes (serveur distant). ${SECRETS_HINT}`),
      env: secretsPatchSchema.optional().describe(`Variables (serveur local). ${SECRETS_HINT}`),
      scope: scopeSchema.optional(),
      enabled: z.boolean().optional(),
      move_to_mcp_pc: z.boolean().optional(),
    }),
    execute: async ({
      server,
      name,
      url,
      command,
      headers,
      env,
      scope,
      enabled,
      move_to_mcp_pc,
    }) => {
      let row = await findServer(server);
      const http = row.transport === 'http';
      if (http && (command || env)) throw new Error('Ce serveur est distant : url et headers.');
      if (!http && (url || headers)) throw new Error('Ce serveur est local : command et env.');
      const moved = Boolean(move_to_mcp_pc && row.computerId);
      if (moved) row = await mcp.moveToMcpComputer(row.id);
      const patch: McpServerUpdate = {};
      if (name !== undefined) patch.name = name;
      if (url !== undefined) patch.url = url;
      if (command !== undefined) patch.command = command;
      const secrets = http ? headers : env;
      if (secrets) patch.secrets = await expandAll(secrets);
      if (scope) patch.scope = await scopeOf(scope);
      if (enabled !== undefined) patch.enabled = enabled;
      if (Object.keys(patch).length > 0) row = await mcp.update(row.id, patch);
      return connect(row, moved ? 'déplacé sur le PC MCP' : 'mis à jour');
    },
  });

  tools.mcp_remove = tool({
    description: 'Retire un serveur MCP : plus aucun bot ne reçoit ses outils.',
    inputSchema: z.object({ server: z.string().min(1) }),
    execute: async ({ server }) => {
      const row = await findServer(server);
      await mcp.remove(row.id);
      changed({ ...row, enabled: false });
      return `Serveur MCP « ${row.name} » retiré.`;
    },
  });

  tools.mcp_setup = tool({
    description:
      "Lance une commande bash sur le PC MCP (utilisateur bot, sudo sans mot de passe, dossier /workspace) : installer un serveur (pipx install …, npm install -g …, uv tool install …), le configurer, se connecter une fois à un service. Le PC démarre s'il dort. Seuls /home/bot et /workspace sont conservés. Les {{vault:ref.champ}} sont remplacés par les valeurs du coffre.",
    inputSchema: z.object({
      intent: intentSchema,
      command: z.string().min(1).max(100_000),
      timeout_seconds: z.number().int().min(1).max(600).default(300),
    }),
    execute: async ({ command, timeout_seconds }) => {
      const result = await mcp.exec(await expand(command), timeout_seconds * 1000);
      // The servers' secrets may be in their config files: never shown back.
      const hide = await mcp.secretValues();
      return [
        `exit code: ${result.exitCode ?? 'aucun'}${result.timedOut ? ' (délai dépassé, processus tué)' : ''}`,
        result.stdout ? `stdout:\n${clip(maskValues(result.stdout, hide))}` : '',
        result.stderr ? `stderr:\n${clip(maskValues(result.stderr, hide), 4_000)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  return tools;
}
