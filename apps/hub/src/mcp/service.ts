import { randomUUID } from 'node:crypto';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  McpCall,
  McpComputer,
  McpScope,
  McpServer,
  McpServerCreate,
  McpServerUpdate,
  McpStatus,
} from '@mowbot/contract';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { BotRow } from '../bots/service';
import type { ExecResult } from '../computers/agent-client';
import { type ComputerService, type Logger, toMcpComputer } from '../computers/service';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import {
  bots,
  computers,
  mcpCalls,
  mcpServers,
  type StoredMcpTool,
  workspaces,
} from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { newAgentTokenSealed } from '../teams/bootstrap';
import type { WorkspaceFiles } from '../workspaces/files';
import { type OAuthState, StoredOAuthProvider } from './oauth';
import { AgentStdioTransport } from './transport';

export type McpServerRow = typeof mcpServers.$inferSelect;

/** Connections unused for this long are closed (stdio servers stop on their computer). */
const IDLE_MS = 10 * 60_000;
/** Starting a stdio server can mean downloading it first (npx, uvx). */
const CONNECT_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 120_000;
const CALLS_KEPT = 200;
/** Setup commands run on the MCP computer (installs can be slow). */
const SETUP_TIMEOUT_MS = 300_000;
/** Shorter values are not masked (too likely to appear by chance). */
const MIN_MASKED = 4;
/** Environment variables whose value is a credential. */
const SECRET_NAME = /token|key|secret|pass|auth|cookie|credential|session|bearer|pat$/i;

export const MCP_COMPUTER_NAME = 'PC MCP';

interface Connection {
  client: Client;
  transport: Transport;
  usedAt: number;
}

/** `GitHub Issues` → `github_issues`: the prefix of a server's tools. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  return slug || 'mcp';
}

export function toMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    transport: row.transport,
    url: row.url,
    command: row.command,
    auth: row.auth,
    secretKeys: row.secretKeys,
    scope: row.scope,
    computerId: row.computerId,
    createdByBotId: row.createdByBotId,
    enabled: row.enabled,
    status: row.status,
    statusDetail: row.statusDetail,
    tools: row.tools.map(({ name, description, readOnly, destructive }) => ({
      name,
      description,
      readOnly,
      destructive,
    })),
    toolsAt: row.toolsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCall(row: typeof mcpCalls.$inferSelect): McpCall {
  return {
    id: row.id,
    serverId: row.serverId,
    botId: row.botId,
    tool: row.tool,
    ok: row.ok,
    durationMs: row.durationMs,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: no answer after ${ms / 1000} s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface McpDeps {
  db: Db;
  events: EventBus;
  masterKey: Buffer;
  computers: ComputerService;
  files: WorkspaceFiles;
}

/** `text` with these values hidden (longest first, so a value containing another goes whole). */
export function maskValues(text: string, values: readonly string[]): string {
  let masked = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length >= MIN_MASKED) masked = masked.replaceAll(value, '••••');
  }
  return masked;
}

/**
 * The MCP gateway: servers the user (or the Chef) adds, the connections to them (remote over
 * HTTP from the hub; local ones over stdio on the MCP computer, through its mow-agent), their
 * tools, and the calls bots make. Servers a bot installed on its own computer before the MCP
 * computer existed still run there, for the bots of that computer, until moved.
 */
export class McpService {
  private log: Logger = { warn: () => {}, error: () => {} };
  private readonly connections = new Map<string, Promise<Connection>>();
  private mcpComputerId: Promise<string> | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: McpDeps) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  /** Closes idle connections now and then. */
  start(): void {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private publish(row: McpServerRow): McpServer {
    const server = toMcpServer(row);
    this.deps.events.publish({ type: 'mcp.updated', server });
    return server;
  }

  async list(): Promise<McpServerRow[]> {
    return this.deps.db.select().from(mcpServers).orderBy(mcpServers.createdAt);
  }

  async row(id: string): Promise<McpServerRow> {
    const [row] = await this.deps.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!row) throw notFound('MCP server not found');
    return row;
  }

  private async freeSlug(name: string, except?: string): Promise<string> {
    const base = slugify(name);
    const taken = new Set(
      (await this.list()).filter((row) => row.id !== except).map((row) => row.slug),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base.slice(0, 17)}_${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private sealSecrets(id: string, secrets: Record<string, string>): string | null {
    return Object.keys(secrets).length
      ? seal(this.deps.masterKey, `mcp:${id}`, JSON.stringify(secrets))
      : null;
  }

  private secretsOf(row: McpServerRow): Record<string, string> {
    return row.secretsSealed
      ? (JSON.parse(open(this.deps.masterKey, `mcp:${row.id}`, row.secretsSealed)) as Record<
          string,
          string
        >)
      : {};
  }

  async create(input: McpServerCreate, by: { botId?: string } = {}): Promise<McpServerRow> {
    if (input.transport === 'http' && !input.url) {
      throw new HttpProblem(400, 'mcp_url_required', 'A remote server needs its URL');
    }
    if (input.transport === 'stdio' && !input.command) {
      throw new HttpProblem(400, 'mcp_command_required', 'A local server needs its command');
    }
    const id = randomUUID();
    const secrets = input.secrets ?? {};
    const [row] = await this.deps.db
      .insert(mcpServers)
      .values({
        id,
        name: input.name,
        slug: await this.freeSlug(input.name),
        transport: input.transport,
        url: input.transport === 'http' ? (input.url ?? null) : null,
        command: input.transport === 'stdio' ? (input.command ?? null) : null,
        auth: input.transport === 'http' ? input.auth : 'none',
        secretsSealed: this.sealSecrets(id, secrets),
        secretKeys: Object.keys(secrets),
        scope: input.scope,
        createdByBotId: by.botId ?? null,
      })
      .returning();
    if (!row) throw new Error('MCP server insert returned no row');
    this.publish(row);
    return row;
  }

  async update(id: string, patch: McpServerUpdate): Promise<McpServerRow> {
    const row = await this.row(id);
    const values: Partial<McpServerRow> = { updatedAt: new Date() };
    if (patch.name !== undefined) {
      values.name = patch.name;
      values.slug = await this.freeSlug(patch.name, id);
    }
    if (patch.url !== undefined) values.url = patch.url;
    if (patch.command !== undefined) values.command = patch.command;
    if (patch.auth !== undefined) values.auth = patch.auth;
    if (patch.scope !== undefined) values.scope = patch.scope;
    if (patch.enabled !== undefined) values.enabled = patch.enabled;
    if (patch.secrets) {
      const secrets = this.secretsOf(row);
      for (const [key, value] of Object.entries(patch.secrets)) {
        if (value === null) delete secrets[key];
        else secrets[key] = value;
      }
      values.secretsSealed = this.sealSecrets(id, secrets);
      values.secretKeys = Object.keys(secrets);
    }
    // A different server (or credentials): connect anew.
    const reconnect = ['url', 'command', 'auth', 'secrets'].some(
      (key) => patch[key as keyof McpServerUpdate] !== undefined,
    );
    if (reconnect) {
      await this.disconnect(id);
      values.status = 'unknown';
      values.statusDetail = null;
      if (patch.auth !== undefined || patch.url !== undefined) values.oauthSealed = null;
    }
    const [updated] = await this.deps.db
      .update(mcpServers)
      .set(values)
      .where(eq(mcpServers.id, id))
      .returning();
    if (!updated) throw notFound('MCP server not found');
    this.publish(updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.disconnect(id);
    await this.deps.db.delete(mcpServers).where(eq(mcpServers.id, id));
    this.deps.events.publish({ type: 'mcp.deleted', serverId: id });
  }

  private async setStatus(id: string, status: McpStatus, detail: string | null) {
    const [row] = await this.deps.db
      .update(mcpServers)
      .set({ status, statusDetail: detail ? detail.slice(0, 500) : null })
      .where(eq(mcpServers.id, id))
      .returning();
    if (row) this.publish(row);
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // OAuth

  private oauthOf(row: McpServerRow): OAuthState {
    return row.oauthSealed
      ? (JSON.parse(
          open(this.deps.masterKey, `mcp-oauth:${row.id}`, row.oauthSealed),
        ) as OAuthState)
      : {};
  }

  private provider(row: McpServerRow, patch: Partial<OAuthState> = {}): StoredOAuthProvider {
    return new StoredOAuthProvider({ ...this.oauthOf(row), ...patch }, async (data) => {
      await this.deps.db
        .update(mcpServers)
        .set({
          oauthSealed: seal(this.deps.masterKey, `mcp-oauth:${row.id}`, JSON.stringify(data)),
        })
        .where(eq(mcpServers.id, row.id));
    });
  }

  /** Where to send the user's browser to approve MowBot (null: already signed in). */
  async oauthStart(id: string, redirectBase: string): Promise<string | null> {
    const row = await this.row(id);
    if (row.transport !== 'http' || row.auth !== 'oauth' || !row.url) {
      throw new HttpProblem(400, 'mcp_not_oauth', 'This server does not sign in with OAuth');
    }
    const redirectUrl = new URL('/api/v1/mcp/oauth/callback', redirectBase).toString();
    const provider = this.provider(row, { redirectUrl });
    await provider.invalidateCredentials('verifier');
    const result = await auth(provider, { serverUrl: row.url });
    if (result === 'AUTHORIZED') {
      await this.refresh(id);
      return null;
    }
    await this.setStatus(id, 'needs_auth', null);
    return provider.authorizationUrl?.toString() ?? null;
  }

  /** The browser came back from the authorization server: finish signing in. */
  async oauthFinish(state: string, code: string): Promise<McpServerRow> {
    const rows = (await this.list()).filter((row) => row.auth === 'oauth' && row.oauthSealed);
    const row = rows.find((candidate) => this.oauthOf(candidate).state === state);
    if (!row?.url) throw new HttpProblem(400, 'mcp_oauth_state', 'Unknown or expired sign-in');
    const provider = this.provider(row);
    const result = await auth(provider, { serverUrl: row.url, authorizationCode: code });
    if (result !== 'AUTHORIZED') {
      throw new HttpProblem(400, 'mcp_oauth_failed', 'The server did not accept the sign-in');
    }
    await this.disconnect(row.id);
    await this.refresh(row.id).catch(() => undefined);
    return this.row(row.id);
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  private key(row: McpServerRow, computerId: string | null) {
    return row.transport === 'stdio' ? `${row.id}:${computerId}` : row.id;
  }

  private async disconnect(id: string): Promise<void> {
    for (const [key, pending] of this.connections) {
      if (!key.startsWith(id)) continue;
      this.connections.delete(key);
      await pending.then((c) => c.client.close()).catch(() => undefined);
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [key, pending] of this.connections) {
      const connection = await pending.catch(() => null);
      if (!connection || now - connection.usedAt > IDLE_MS) {
        this.connections.delete(key);
        await connection?.client.close().catch(() => undefined);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The MCP computer

  /** The MCP computer's id, creating it (and its own workspace) on first need. */
  async mcpComputer(): Promise<string> {
    if (!this.mcpComputerId) {
      const pending = this.ensureMcpComputer();
      this.mcpComputerId = pending;
      pending.catch(() => {
        if (this.mcpComputerId === pending) this.mcpComputerId = null;
      });
    }
    return this.mcpComputerId;
  }

  private async ensureMcpComputer(): Promise<string> {
    const { db, files, masterKey } = this.deps;
    const [existing] = await db.select().from(computers).where(eq(computers.kind, 'mcp'));
    if (existing) {
      await files.ensure(existing.workspaceId);
      return existing.id;
    }
    try {
      const created = await db.transaction(async (tx) => {
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: MCP_COMPUTER_NAME, ownerType: 'mcp' })
          .returning();
        if (!workspace) throw new Error('Workspace insert returned no row');
        const [row] = await tx
          .insert(computers)
          .values({
            name: MCP_COMPUTER_NAME,
            kind: 'mcp',
            workspaceId: workspace.id,
            agentTokenSealed: newAgentTokenSealed(masterKey),
          })
          .returning();
        if (!row) throw new Error('Computer insert returned no row');
        return row;
      });
      await files.ensure(created.workspaceId);
      return created.id;
    } catch (error) {
      // Another hub process created it first.
      if (!isUniqueViolation(error)) throw error;
      return this.ensureMcpComputer();
    }
  }

  /** The MCP computer's state (asleep until a local server or a setup command needs it). */
  async computerState(): Promise<McpComputer> {
    const [row] = await this.deps.db.select().from(computers).where(eq(computers.kind, 'mcp'));
    return toMcpComputer(row);
  }

  async startComputer(): Promise<McpComputer> {
    await this.deps.computers.start(await this.mcpComputer());
    return this.computerState();
  }

  /** Puts the MCP computer to sleep: its servers stop and start again on their next use. */
  async stopComputer(): Promise<McpComputer> {
    const state = await this.computerState();
    if (state.id) await this.deps.computers.stop(state.id);
    return this.computerState();
  }

  /**
   * Runs a shell command on the MCP computer (as `bot`, in /workspace; its home is kept), e.g.
   * installing a server or signing in to a service once.
   */
  async exec(command: string, timeoutMs = SETUP_TIMEOUT_MS): Promise<ExecResult> {
    const agent = await this.agentFor(await this.mcpComputer());
    return agent.exec(command, { timeoutMs });
  }

  /** Where a server runs: the hub (remote), its legacy computer, or the MCP computer. */
  private async computerOf(row: McpServerRow): Promise<string | null> {
    if (row.transport !== 'stdio') return null;
    return row.computerId ?? (await this.mcpComputer());
  }

  /** The computer's agent, starting the computer if it sleeps. */
  private async agentFor(computerId: string) {
    const { computers } = this.deps;
    let pc = await computers.get(computerId);
    if (pc.status !== 'running') {
      await computers.start(computerId);
      await computers.waitForBoot(computerId);
      pc = await computers.get(computerId);
      if (pc.status !== 'running') {
        const what = pc.kind === 'mcp' ? 'The MCP computer' : `Computer ${pc.name}`;
        throw new Error(`${what} did not start${pc.statusDetail ? `: ${pc.statusDetail}` : ''}`);
      }
    }
    void computers.touch(computerId);
    return computers.agentFor(computerId);
  }

  private async open(row: McpServerRow, computerId: string | null): Promise<Connection> {
    const client = new Client({ name: 'MowBot', version: '1.0.0' });
    const key = this.key(row, computerId);
    // Set before connecting: the client chains its own handler (failing pending calls) to it.
    const closed = () => this.connections.delete(key);
    let transport: Transport;
    if (row.transport === 'stdio') {
      if (!computerId || !row.command) throw new Error('A local MCP server runs on a computer');
      const agent = await this.agentFor(computerId);
      const stdio = new AgentStdioTransport(
        agent.stdioEndpoint(),
        row.command,
        this.secretsOf(row),
      );
      transport = stdio;
      transport.onclose = closed;
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, row.name);
      } catch (error) {
        await client.close().catch(() => undefined);
        // What the program said before it stopped: "command not found", a missing variable…
        const said = stdio.stderr.trim().slice(-600);
        throw new Error(said ? `${message(error)}. ${said}` : message(error));
      }
    } else {
      if (!row.url) throw new Error('A remote MCP server needs its URL');
      const url = new URL(row.url);
      const options = {
        requestInit: { headers: this.secretsOf(row) },
        ...(row.auth === 'oauth' ? { authProvider: this.provider(row) } : {}),
      };
      transport = new StreamableHTTPClientTransport(url, options);
      transport.onclose = closed;
      try {
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, row.name);
      } catch (error) {
        if (error instanceof UnauthorizedError) throw error;
        // Older servers speak SSE.
        transport = new SSEClientTransport(url, options);
        transport.onclose = closed;
        await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, row.name);
      }
    }
    return { client, transport, usedAt: Date.now() };
  }

  private async connection(row: McpServerRow, computerId: string | null): Promise<Connection> {
    const key = this.key(row, computerId);
    let pending = this.connections.get(key);
    if (!pending) {
      pending = this.open(row, computerId);
      this.connections.set(key, pending);
      pending.catch(() => this.connections.delete(key));
    }
    const connection = await pending;
    connection.usedAt = Date.now();
    return connection;
  }

  /** Connects, lists the tools and keeps them; the server's status follows. */
  async refresh(id: string): Promise<McpServerRow> {
    const row = await this.row(id);
    try {
      const { client } = await this.connection(row, await this.computerOf(row));
      const tools: StoredMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(
          client.listTools(cursor ? { cursor } : {}),
          CALL_TIMEOUT_MS,
          row.name,
        );
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            readOnly: tool.annotations?.readOnlyHint ?? null,
            destructive: tool.annotations?.destructiveHint ?? null,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      const [updated] = await this.deps.db
        .update(mcpServers)
        .set({ tools, toolsAt: new Date(), status: 'ok', statusDetail: null })
        .where(eq(mcpServers.id, id))
        .returning();
      if (!updated) throw notFound('MCP server not found');
      this.publish(updated);
      return updated;
    } catch (error) {
      await this.disconnect(id);
      const needsAuth = error instanceof UnauthorizedError;
      if (!needsAuth) this.log.warn({ err: error, serverId: id }, 'MCP server unreachable');
      await this.setStatus(
        id,
        needsAuth ? 'needs_auth' : 'error',
        needsAuth ? null : this.mask(row, message(error)),
      );
      throw error instanceof HttpProblem
        ? error
        : new HttpProblem(
            502,
            needsAuth ? 'mcp_needs_auth' : 'mcp_unreachable',
            needsAuth ? 'Sign in to this server first' : this.mask(row, message(error)),
          );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Bots

  private inScope(row: McpServerRow, bot: { id: string; teamId: string | null }): boolean {
    if (row.scope.kind === 'all') return true;
    if (row.scope.kind === 'bots') return row.scope.ids.includes(bot.id);
    return bot.teamId !== null && row.scope.ids.includes(bot.teamId);
  }

  /**
   * The servers whose tools this bot gets: those in scope, wherever the bot works (a local one
   * runs on the MCP computer), except legacy ones, kept to the bots of their computer.
   */
  async accessibleTo(bot: BotRow): Promise<McpServerRow[]> {
    const rows = await this.deps.db.select().from(mcpServers).where(eq(mcpServers.enabled, true));
    return rows.filter((row) => this.canUse(row, bot));
  }

  canUse(row: McpServerRow, bot: Pick<BotRow, 'id' | 'teamId' | 'computerId'>): boolean {
    return (
      row.enabled &&
      this.inScope(row, bot) &&
      (row.computerId === null || row.computerId === bot.computerId)
    );
  }

  /** Calls a tool for a bot (local servers run on the MCP computer) and keeps a trace. */
  async call(
    row: McpServerRow,
    bot: BotRow,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const started = Date.now();
    let error: string | null = null;
    try {
      const computerId = await this.computerOf(row);
      const { client } = await this.connection(row, computerId);
      // In use: the MCP computer stays awake.
      if (computerId) void this.deps.computers.touch(computerId);
      const result = (await withTimeout(
        client.callTool({ name: tool, arguments: args }),
        CALL_TIMEOUT_MS,
        `${row.name} · ${tool}`,
      )) as CallToolResult;
      if (result.isError) error = this.mask(row, textOf(result)).slice(0, 500) || 'error';
      if (row.status !== 'ok') await this.setStatus(row.id, 'ok', null);
      return result;
    } catch (caught) {
      error = this.mask(row, message(caught));
      if (caught instanceof UnauthorizedError) await this.setStatus(row.id, 'needs_auth', null);
      throw caught;
    } finally {
      await this.deps.db.insert(mcpCalls).values({
        serverId: row.id,
        botId: bot.id,
        tool,
        ok: error === null,
        durationMs: Date.now() - started,
        error,
      });
      await this.pruneCalls(row.id);
    }
  }

  private async pruneCalls(serverId: string): Promise<void> {
    const kept = await this.deps.db
      .select({ createdAt: mcpCalls.createdAt })
      .from(mcpCalls)
      .where(eq(mcpCalls.serverId, serverId))
      .orderBy(desc(mcpCalls.createdAt))
      .limit(1)
      .offset(CALLS_KEPT - 1);
    const oldest = kept[0];
    if (oldest) {
      await this.deps.db
        .delete(mcpCalls)
        .where(and(eq(mcpCalls.serverId, serverId), lt(mcpCalls.createdAt, oldest.createdAt)));
    }
  }

  async calls(serverId: string): Promise<McpCall[]> {
    await this.row(serverId);
    const rows = await this.deps.db
      .select()
      .from(mcpCalls)
      .where(eq(mcpCalls.serverId, serverId))
      .orderBy(desc(mcpCalls.createdAt))
      .limit(100);
    return rows.map(toCall);
  }

  // -------------------------------------------------------------------------------------------
  // Secrets

  /**
   * The secret values a server was given: its headers, and the variables that look like
   * credentials (by name, or a long opaque value); not plain settings (`LOG_LEVEL=info`), which
   * would hide ordinary words. With `Bearer …`, also the bare token.
   */
  private secretValuesOf(row: McpServerRow): string[] {
    return Object.entries(this.secretsOf(row)).flatMap(([key, value]) => {
      const secret =
        row.transport === 'http' ||
        SECRET_NAME.test(key) ||
        (value.length >= 20 && !/\s/.test(value) && !value.startsWith('/'));
      if (!secret) return [];
      const bare = /^bearer\s+(.+)$/i.exec(value)?.[1];
      return bare ? [value, bare] : [value];
    });
  }

  /** `text` without the server's secret values (what it says may echo them). */
  mask(row: McpServerRow, text: string): string {
    return row.secretsSealed ? maskValues(text, this.secretValuesOf(row)) : text;
  }

  /** Every server's secret values, to hide them from what the MCP computer prints. */
  async secretValues(): Promise<string[]> {
    return (await this.list()).flatMap((row) => this.secretValuesOf(row));
  }

  // -------------------------------------------------------------------------------------------
  // Legacy servers (installed by a bot on its own computer)

  /**
   * Moves a server a bot installed on its own computer to the MCP computer. The bots that had it
   * keep it: a server for "all" becomes one for that computer's team (or its bots).
   */
  async moveToMcpComputer(id: string): Promise<McpServerRow> {
    const row = await this.row(id);
    if (row.transport !== 'stdio' || !row.computerId) {
      throw new HttpProblem(409, 'mcp_not_legacy', 'This server already runs on the MCP computer');
    }
    let scope: McpScope = row.scope;
    if (scope.kind === 'all') {
      const [pc] = await this.deps.db
        .select({ kind: computers.kind, teamId: computers.teamId })
        .from(computers)
        .where(eq(computers.id, row.computerId));
      if (pc?.kind === 'team' && pc.teamId) {
        scope = { kind: 'teams', ids: [pc.teamId] };
      } else {
        const users = await this.deps.db
          .select({ id: bots.id })
          .from(bots)
          .where(eq(bots.computerId, row.computerId));
        scope = { kind: 'bots', ids: users.map((bot) => bot.id) };
      }
    }
    await this.disconnect(id);
    const [updated] = await this.deps.db
      .update(mcpServers)
      .set({
        computerId: null,
        scope,
        status: 'unknown',
        statusDetail: null,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id))
      .returning();
    if (!updated) throw notFound('MCP server not found');
    this.publish(updated);
    return updated;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const pending of this.connections.values()) {
      await pending.then((c) => c.client.close()).catch(() => undefined);
    }
    this.connections.clear();
  }
}

/** The text parts of a tool's result. */
export function textOf(result: CallToolResult): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
}
