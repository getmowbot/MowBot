import type {
  McpCall,
  McpScope,
  McpServer,
  McpServerCreate,
  McpServerUpdate,
  McpTool,
  McpTransport,
} from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { type HeaderRow, isHttpUrl } from './provider-form';
import { timeAgo } from './time';
import { computerName } from './vault';

/**
 * Pure logic of the MCP screens (no React, no native modules): status and rows' text, who gets
 * a server's tools, its tools and calls, and what the forms send (secrets are write-only).
 */

type Named = { id: string; name: string };

const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** By name (events append new servers at the end). */
export function sortServers(servers: readonly McpServer[]): McpServer[] {
  return [...servers].sort(
    (a, b) => byText(a.name, b.name) || a.createdAt.localeCompare(b.createdAt),
  );
}

// ---------------------------------------------------------------------------------------------
// Status

/** What a server's row shows: the hub's status, or off. */
export type McpState = 'ok' | 'error' | 'needsAuth' | 'pending' | 'disabled';

export function serverState(server: Pick<McpServer, 'enabled' | 'status' | 'auth'>): McpState {
  if (!server.enabled) return 'disabled';
  switch (server.status) {
    case 'ok':
      return 'ok';
    case 'error':
      return 'error';
    case 'needs_auth':
      return 'needsAuth';
    case 'unknown':
      // An OAuth server is only connected once the user signed in.
      return server.auth === 'oauth' ? 'needsAuth' : 'pending';
  }
}

export interface StatusText {
  label: string;
  /** Why (the server's own words for an error), or what happens next. */
  hint: string;
}

export function statusText(
  server: McpServer,
  t: TFunction,
  language: string,
  now?: number,
): StatusText {
  const state = serverState(server);
  const label = t(`mcp.status.${state}`);
  switch (state) {
    case 'ok':
      return {
        label,
        hint: server.toolsAt
          ? t('mcp.statusHints.ok', { time: timeAgo(server.toolsAt, t, language, now) })
          : t('mcp.statusHints.okNow'),
      };
    case 'error':
      return { label, hint: server.statusDetail ?? t('mcp.statusHints.error') };
    case 'pending':
      return {
        label,
        hint:
          server.transport === 'stdio'
            ? t('mcp.statusHints.pendingLocal')
            : t('mcp.statusHints.pending'),
      };
    default:
      return { label, hint: t(`mcp.statusHints.${state}`) };
  }
}

export function transportLabel(transport: McpTransport, t: TFunction): string {
  return t(`mcp.transports.${transport}`);
}

// ---------------------------------------------------------------------------------------------
// Who gets the tools

export interface ScopeNames {
  bots: readonly Named[] | undefined;
  teams: readonly Named[] | undefined;
}

/** Names shown in a summary before "+2". */
const SHOWN_NAMES = 2;

/** "Tous les bots", "Équipe : Marketing", "Bots : Nova, Orion +1". */
export function scopeSummary(scope: McpScope, names: ScopeNames, t: TFunction): string {
  if (scope.kind === 'all') return t('mcp.scope.summary.all');
  const count = scope.ids.length;
  if (count === 0) return t('mcp.scope.summary.nobody');
  const list = scope.kind === 'teams' ? names.teams : names.bots;
  const known = scope.ids.flatMap((id) => {
    const name = list?.find((item) => item.id === id)?.name;
    return name ? [name] : [];
  });
  // Not loaded yet, or all deleted: a count.
  if (known.length === 0) return t(`mcp.scope.summary.${scope.kind}Count`, { count });
  const shown = known.slice(0, SHOWN_NAMES);
  const rest = count - shown.length;
  const text = rest > 0 ? `${shown.join(', ')} +${rest}` : shown.join(', ');
  return t(`mcp.scope.summary.${scope.kind}`, { count, names: text });
}

/** Bots concerned, but none picked yet. */
export function scopeProblem(scope: McpScope): 'scope' | null {
  return scope.kind !== 'all' && scope.ids.length === 0 ? 'scope' : null;
}

/** Choosing "all", "teams" or "bots": the ids of the other kind do not carry over. */
export function scopeWithKind(scope: McpScope, kind: McpScope['kind']): McpScope {
  return kind === scope.kind ? scope : { kind, ids: [] };
}

/** Adds the team or bot, or takes it out. */
export function toggleScopeId(scope: McpScope, id: string): McpScope {
  return {
    ...scope,
    ids: scope.ids.includes(id) ? scope.ids.filter((x) => x !== id) : [...scope.ids, id],
  };
}

export function sameScope(a: McpScope, b: McpScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'all') return true;
  return a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id));
}

/** Ids of teams or bots deleted since: not shown, not sent back. */
export function liveScope(scope: McpScope, names: ScopeNames): McpScope {
  const list = scope.kind === 'teams' ? names.teams : scope.kind === 'bots' ? names.bots : [];
  if (!list) return scope;
  return { ...scope, ids: scope.ids.filter((id) => list.some((item) => item.id === id)) };
}

interface RowNames extends ScopeNames {
  computers: readonly Named[] | undefined;
}

/** "Installé par Nova sur PC de Nova": a server a bot added for its own computer. */
export function installedText(
  server: Pick<McpServer, 'createdByBotId' | 'computerId'>,
  names: RowNames,
  t: TFunction,
): string | null {
  const { createdByBotId, computerId } = server;
  if (!createdByBotId && !computerId) return null;
  const bot = createdByBotId
    ? (names.bots?.find((b) => b.id === createdByBotId)?.name ?? t('common.deletedBot'))
    : null;
  const pc = computerId ? computerName(computerId, names.computers, t) : null;
  if (bot && pc) return t('mcp.installed.byOn', { bot, pc });
  if (bot) return t('mcp.installed.by', { bot });
  return t('mcp.installed.on', { pc });
}

/** Under a row's name: "Connecté · Distant · 12 outils", then who gets them (and on which PC). */
export function serverHint(server: McpServer, names: RowNames, t: TFunction): string {
  const kind = [
    t(`mcp.status.${serverState(server)}`),
    transportLabel(server.transport, t),
    server.toolsAt ? t('mcp.tools.count', { count: server.tools.length }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const who = [
    scopeSummary(server.scope, names, t),
    server.computerId
      ? t('mcp.installed.only', { pc: computerName(server.computerId, names.computers, t) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${kind}\n${who}`;
}

// ---------------------------------------------------------------------------------------------
// Tools and calls

export type ToolAccess = 'readOnly' | 'writes';

/** What the server says a tool does (null: it does not say). */
export function toolAccess(tool: Pick<McpTool, 'readOnly' | 'destructive'>): ToolAccess | null {
  if (tool.readOnly === true) return 'readOnly';
  if (tool.destructive === true || tool.readOnly === false) return 'writes';
  return null;
}

/** "850 ms", "1,2 s", "14 s". */
export function durationText(ms: number, language: string): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = (ms / 1_000).toFixed(ms < 10_000 ? 1 : 0);
  return `${language.startsWith('fr') ? seconds.replace('.', ',') : seconds} s`;
}

/** "Nova · 1,2 s", then what failed. */
export function callHint(
  call: Pick<McpCall, 'botId' | 'durationMs' | 'ok' | 'error'>,
  bots: ReadonlyMap<string, { name: string }>,
  t: TFunction,
  language: string,
): string {
  const bot = (call.botId ? bots.get(call.botId)?.name : null) ?? t('common.deletedBot');
  return [
    bot,
    durationText(call.durationMs, language),
    call.ok ? null : (call.error ?? t('mcp.calls.failed')),
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Forms

/** How a remote server is signed in to: nothing, a token (Authorization header) or OAuth. */
export type AuthChoice = 'none' | 'token' | 'oauth';
export const AUTH_CHOICES: readonly AuthChoice[] = ['none', 'token', 'oauth'];

export const AUTHORIZATION = 'Authorization';
export const isAuthorization = (key: string) => key.toLowerCase() === 'authorization';

export function authChoice(server: Pick<McpServer, 'auth' | 'secretKeys'>): AuthChoice {
  if (server.auth === 'oauth') return 'oauth';
  return server.secretKeys.some(isAuthorization) ? 'token' : 'none';
}

/** A bare token becomes `Bearer <token>`; a value with its scheme ("Basic …") stays as typed. */
export function authorizationValue(typed: string): string {
  const value = typed.trim();
  return /\s/.test(value) ? value : `Bearer ${value}`;
}

/** A secret as sent: trimmed, an Authorization header given its scheme. */
export function secretValue(transport: McpTransport, key: string, typed: string): string {
  return transport === 'http' && isAuthorization(key) ? authorizationValue(typed) : typed.trim();
}

/** Same rules as HTTP (token characters) for headers; shell names for environment variables. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET = 10_000;

/** Header names ignore case; environment variables do not. */
const folded = (transport: McpTransport, key: string) =>
  transport === 'http' ? key.toLowerCase() : key;

export type SecretProblem = 'secretName' | 'secretValue' | 'secretDuplicate';

/** A typed value the hub or the server would refuse. */
function badValue(transport: McpTransport, value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > MAX_SECRET || (transport === 'http' && /[\r\n]/.test(trimmed));
}

/** New name / value pairs, checked before sending (`taken`: keys already there). */
export function secretsProblem(
  transport: McpTransport,
  rows: readonly HeaderRow[],
  taken: readonly string[] = [],
): SecretProblem | null {
  const seen = new Set(taken.map((key) => folded(transport, key)));
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) {
      // A value without a name would be silently dropped: say so.
      if (row.value.trim()) return 'secretName';
      continue;
    }
    if (name.length > 100 || !(transport === 'http' ? HEADER_NAME : ENV_NAME).test(name)) {
      return 'secretName';
    }
    if (!row.value.trim() || badValue(transport, row.value)) return 'secretValue';
    const key = folded(transport, name);
    if (seen.has(key)) return 'secretDuplicate';
    seen.add(key);
  }
  return null;
}

/** The pairs as sent (rows left blank are ignored). */
export function secretsRecord(
  transport: McpTransport,
  rows: readonly HeaderRow[],
): Record<string, string> {
  return Object.fromEntries(
    rows
      .filter((row) => row.name.trim())
      .map((row) => [row.name.trim(), secretValue(transport, row.name.trim(), row.value)]),
  );
}

/** The add and edit forms as typed. */
export interface McpDraft {
  name: string;
  transport: McpTransport;
  url: string;
  auth: AuthChoice;
  /** Write-only: editing, empty keeps the stored one. */
  token: string;
  command: string;
  /** Extra headers (remote) or environment variables (local), name / value. */
  secrets: HeaderRow[];
  scope: McpScope;
}

export const ALL_BOTS: McpScope = { kind: 'all', ids: [] };

export function emptyDraft(transport: McpTransport = 'http'): McpDraft {
  return {
    name: '',
    transport,
    url: '',
    auth: 'none',
    token: '',
    command: '',
    secrets: [],
    scope: ALL_BOTS,
  };
}

/** Editing: what the server has (secrets are never shown back). */
export function serverDraft(server: McpServer): McpDraft {
  return {
    name: server.name,
    transport: server.transport,
    url: server.url ?? '',
    auth: authChoice(server),
    token: '',
    command: server.command ?? '',
    secrets: [],
    scope: server.scope,
  };
}

export type McpFormProblem = 'name' | 'url' | 'command' | 'token' | 'scope' | SecretProblem;

/** What the hub would refuse (`stored`: editing that server, whose token may already be set). */
export function draftProblem(
  draft: McpDraft,
  stored?: Pick<McpServer, 'auth' | 'secretKeys'>,
): McpFormProblem | null {
  if (!draft.name.trim()) return 'name';
  if (draft.transport === 'http') {
    if (!isHttpUrl(draft.url)) return 'url';
    if (draft.auth === 'token') {
      const token = draft.token.trim();
      // Choosing a token means typing one; one already stored is kept.
      if (!token && !(stored && authChoice(stored) === 'token')) return 'token';
      if (badValue('http', token)) return 'token';
    }
  } else if (!draft.command.trim()) {
    return 'command';
  }
  // Editing leaves the bots to the server's page.
  if (!stored && scopeProblem(draft.scope)) return 'scope';
  const taken = draft.transport === 'http' && draft.auth === 'token' ? [AUTHORIZATION] : [];
  return secretsProblem(draft.transport, draft.secrets, taken);
}

/** What adding a server sends (empty secrets left out). */
export function createBody(draft: McpDraft): McpServerCreate {
  const name = draft.name.trim();
  const common = { name, scope: draft.scope };
  if (draft.transport === 'stdio') {
    const secrets = secretsRecord('stdio', draft.secrets);
    return {
      ...common,
      transport: 'stdio',
      command: draft.command.trim(),
      auth: 'none',
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    };
  }
  const secrets = {
    ...secretsRecord('http', draft.secrets),
    ...(draft.auth === 'token' ? { [AUTHORIZATION]: authorizationValue(draft.token) } : {}),
  };
  return {
    ...common,
    transport: 'http',
    url: draft.url.trim(),
    auth: draft.auth === 'oauth' ? 'oauth' : 'none',
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
}

/** What saving the edit form sends: name, address or command, and how it signs in. */
export function serverChanges(server: McpServer, draft: McpDraft): McpServerUpdate {
  const body: McpServerUpdate = {};
  const name = draft.name.trim();
  if (name !== server.name) body.name = name;
  if (server.transport === 'stdio') {
    const command = draft.command.trim();
    if (command !== (server.command ?? '')) body.command = command;
    return body;
  }
  const url = draft.url.trim();
  if (url !== (server.url ?? '')) body.url = url;
  const auth = draft.auth === 'oauth' ? 'oauth' : 'none';
  if (auth !== server.auth) body.auth = auth;
  const tokenKey = server.secretKeys.find(isAuthorization) ?? AUTHORIZATION;
  if (draft.auth === 'token' && draft.token.trim()) {
    body.secrets = { [tokenKey]: authorizationValue(draft.token) };
  } else if (draft.auth !== 'token' && authChoice(server) === 'token') {
    // No token anymore (none, or OAuth instead).
    body.secrets = { [tokenKey]: null };
  }
  return body;
}

/** Stored values replaced (the ones typed) and new pairs added, from the server's page. */
export function secretsPatch(
  transport: McpTransport,
  typed: Readonly<Record<string, string>>,
  added: readonly HeaderRow[],
): Record<string, string> {
  const replaced = Object.entries(typed)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => [key, secretValue(transport, key, value)] as const);
  return { ...Object.fromEntries(replaced), ...secretsRecord(transport, added) };
}

/** Replacements or new pairs the hub would refuse. */
export function secretsPatchProblem(
  transport: McpTransport,
  typed: Readonly<Record<string, string>>,
  added: readonly HeaderRow[],
  stored: readonly string[],
): SecretProblem | null {
  if (Object.values(typed).some((value) => badValue(transport, value))) return 'secretValue';
  return secretsProblem(transport, added, stored);
}

/** What removing one header or variable sends. */
export function removeSecretBody(key: string): McpServerUpdate {
  return { secrets: { [key]: null } };
}
