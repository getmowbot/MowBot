import type { McpServer } from '@mowbot/contract';
import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { mcpCall, mcpServer, translator } from '../test/fixtures';
import { applyServerEvent } from './event-cache';
import {
  ALL_BOTS,
  authChoice,
  authorizationValue,
  callHint,
  createBody,
  draftProblem,
  durationText,
  emptyDraft,
  installedText,
  liveScope,
  type McpDraft,
  removeSecretBody,
  sameScope,
  scopeSummary,
  scopeWithKind,
  secretsPatch,
  secretsPatchProblem,
  secretsProblem,
  serverChanges,
  serverDraft,
  serverHint,
  serverState,
  sortServers,
  statusText,
  toggleScopeId,
  toolAccess,
} from './mcp';
import { headerRow } from './provider-form';
import { keys } from './query-keys';

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const bots = [
  { id: 'bot-1', name: 'Nova' },
  { id: 'bot-2', name: 'Orion' },
  { id: 'bot-3', name: 'Vega' },
];
const teams = [
  { id: 'team-1', name: 'Marketing' },
  { id: 'team-2', name: 'Dev' },
];
const computers = [{ id: 'pc-1', name: 'PC de Nova' }];
const names = { bots, teams, computers };

describe('status', () => {
  it('tells connected, failing, waiting for a sign-in, pending and off apart', () => {
    expect(serverState(mcpServer({ status: 'ok' }))).toBe('ok');
    expect(serverState(mcpServer({ status: 'error' }))).toBe('error');
    expect(serverState(mcpServer({ status: 'needs_auth' }))).toBe('needsAuth');
    expect(serverState(mcpServer({ status: 'unknown' }))).toBe('pending');
    // An OAuth server added but never signed in to.
    expect(serverState(mcpServer({ status: 'unknown', auth: 'oauth' }))).toBe('needsAuth');
    expect(serverState(mcpServer({ status: 'ok', enabled: false }))).toBe('disabled');
  });

  it('words the status with its reason', () => {
    const ok = mcpServer({ toolsAt: minutesAgo(5) });
    expect(statusText(ok, fr, 'fr', NOW)).toEqual({
      label: 'Connecté',
      hint: 'Outils listés il y a 5 min',
    });
    expect(statusText(ok, en, 'en', NOW).hint).toBe('Tools listed 5 min ago');
    const failing = mcpServer({ status: 'error', statusDetail: 'ECONNREFUSED' });
    expect(statusText(failing, en, 'en')).toEqual({ label: 'Error', hint: 'ECONNREFUSED' });
    expect(statusText(mcpServer({ status: 'error' }), fr, 'fr').hint).toBe(
      'Le serveur n’a pas répondu.',
    );
    expect(statusText(mcpServer({ status: 'needs_auth' }), fr, 'fr').label).toBe(
      'Connexion requise',
    );
    const local = mcpServer({ transport: 'stdio', status: 'unknown' });
    expect(statusText(local, en, 'en')).toEqual({
      label: 'Pending',
      hint: 'Starting on a bot’s PC and listing its tools…',
    });
    expect(statusText(mcpServer({ enabled: false }), fr, 'fr').label).toBe('Désactivé');
  });
});

describe('who gets the tools', () => {
  it('summarizes all bots, teams and bots', () => {
    expect(scopeSummary(ALL_BOTS, names, fr)).toBe('Tous les bots');
    expect(scopeSummary({ kind: 'teams', ids: ['team-1'] }, names, fr)).toBe('Équipe : Marketing');
    expect(scopeSummary({ kind: 'teams', ids: ['team-1', 'team-2'] }, names, en)).toBe(
      'Teams: Marketing, Dev',
    );
    expect(scopeSummary({ kind: 'bots', ids: ['bot-1', 'bot-2', 'bot-3'] }, names, fr)).toBe(
      'Bots : Nova, Orion +1',
    );
    expect(scopeSummary({ kind: 'bots', ids: [] }, names, en)).toBe('No bots');
  });

  it('counts what it cannot name (not loaded, or deleted)', () => {
    const unknown = { bots: undefined, teams: undefined };
    expect(scopeSummary({ kind: 'teams', ids: ['team-1', 'team-2'] }, unknown, fr)).toBe(
      '2 équipes',
    );
    expect(scopeSummary({ kind: 'bots', ids: ['gone'] }, names, en)).toBe('1 bot');
    // Deleted ones still count in the "+".
    expect(scopeSummary({ kind: 'bots', ids: ['gone', 'bot-1'] }, names, en)).toBe('Bots: Nova +1');
  });

  it('picks teams or bots', () => {
    const teamScope = toggleScopeId(scopeWithKind(ALL_BOTS, 'teams'), 'team-1');
    expect(teamScope).toEqual({ kind: 'teams', ids: ['team-1'] });
    expect(toggleScopeId(teamScope, 'team-1')).toEqual({ kind: 'teams', ids: [] });
    // Team ids do not carry over to bots.
    expect(scopeWithKind(teamScope, 'bots')).toEqual({ kind: 'bots', ids: [] });
    expect(scopeWithKind(teamScope, 'teams')).toBe(teamScope);
    expect(sameScope({ kind: 'bots', ids: ['a', 'b'] }, { kind: 'bots', ids: ['b', 'a'] })).toBe(
      true,
    );
    expect(sameScope({ kind: 'bots', ids: ['a'] }, { kind: 'teams', ids: ['a'] })).toBe(false);
    expect(sameScope(ALL_BOTS, { kind: 'all', ids: [] })).toBe(true);
    expect(liveScope({ kind: 'bots', ids: ['bot-1', 'gone'] }, names)).toEqual({
      kind: 'bots',
      ids: ['bot-1'],
    });
    expect(liveScope({ kind: 'bots', ids: ['gone'] }, { bots: undefined, teams })).toEqual({
      kind: 'bots',
      ids: ['gone'],
    });
  });

  it('says which bot installed it, on which PC', () => {
    expect(installedText(mcpServer(), names, fr)).toBeNull();
    expect(
      installedText(mcpServer({ createdByBotId: 'bot-1', computerId: 'pc-1' }), names, fr),
    ).toBe('Installé par Nova sur PC de Nova');
    expect(installedText(mcpServer({ createdByBotId: 'gone' }), names, en)).toBe(
      'Installed by Deleted bot',
    );
    expect(installedText(mcpServer({ computerId: 'pc-2' }), names, en)).toBe(
      'Installed on Deleted PC',
    );
  });

  it('sums a server up on its row', () => {
    const github = mcpServer({
      toolsAt: minutesAgo(1),
      tools: [
        { name: 'a', description: null, readOnly: null, destructive: null },
        { name: 'b', description: null, readOnly: null, destructive: null },
      ],
      scope: { kind: 'teams', ids: ['team-2'] },
    });
    expect(serverHint(github, names, fr)).toBe('Connecté · Distant · 2 outils\nÉquipe : Dev');
    const local = mcpServer({ transport: 'stdio', status: 'unknown', computerId: 'pc-1' });
    expect(serverHint(local, names, en)).toBe('Pending · Local\nAll bots · on PC de Nova only');
  });

  it('sorts servers by name', () => {
    const list = [mcpServer({ name: 'notion' }), mcpServer({ name: 'GitHub' })];
    expect(sortServers(list).map((s) => s.name)).toEqual(['GitHub', 'notion']);
  });
});

describe('tools and calls', () => {
  it('reads what a tool does from its annotations', () => {
    expect(toolAccess({ readOnly: true, destructive: null })).toBe('readOnly');
    expect(toolAccess({ readOnly: null, destructive: true })).toBe('writes');
    expect(toolAccess({ readOnly: false, destructive: null })).toBe('writes');
    expect(toolAccess({ readOnly: null, destructive: null })).toBeNull();
  });

  it('words a call: bot, duration, failure', () => {
    const byId = new Map([['bot-1', { name: 'Nova' }]]);
    expect(callHint(mcpCall({ botId: 'bot-1', durationMs: 1_234 }), byId, fr, 'fr')).toBe(
      'Nova · 1,2 s',
    );
    expect(
      callHint(mcpCall({ botId: 'gone', ok: false, error: 'Not Found' }), byId, en, 'en'),
    ).toBe('Deleted bot · 120 ms · Not Found');
    expect(callHint(mcpCall({ botId: null, ok: false }), byId, fr, 'fr')).toBe(
      'Bot supprimé · 120 ms · échec',
    );
    expect(durationText(850, 'en')).toBe('850 ms');
    expect(durationText(12_400, 'fr')).toBe('12 s');
    expect(durationText(1_500, 'en')).toBe('1.5 s');
  });
});

describe('forms', () => {
  const remote = (patch: Partial<McpDraft> = {}): McpDraft => ({
    ...emptyDraft('http'),
    name: ' GitHub ',
    url: ' https://api.githubcopilot.com/mcp/ ',
    ...patch,
  });

  it('turns a token into a Bearer header', () => {
    expect(authorizationValue(' ghp_123 ')).toBe('Bearer ghp_123');
    expect(authorizationValue('Basic dXNlcjpwYXNz')).toBe('Basic dXNlcjpwYXNz');
    expect(authChoice(mcpServer({ auth: 'oauth' }))).toBe('oauth');
    expect(authChoice(mcpServer({ secretKeys: ['authorization'] }))).toBe('token');
    expect(authChoice(mcpServer({ secretKeys: ['X-Api-Key'] }))).toBe('none');
  });

  it('builds a remote server with its token and headers', () => {
    expect(
      createBody(
        remote({
          auth: 'token',
          token: 'ghp_123',
          secrets: [headerRow(' X-Org ', ' mowbot '), headerRow('', '')],
        }),
      ),
    ).toEqual({
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: 'none',
      secrets: { 'X-Org': 'mowbot', Authorization: 'Bearer ghp_123' },
      scope: { kind: 'all', ids: [] },
    });
    expect(createBody(remote({ auth: 'oauth', token: 'ignored' }))).toEqual({
      name: 'GitHub',
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      auth: 'oauth',
      scope: { kind: 'all', ids: [] },
    });
  });

  it('builds a local server with its environment', () => {
    expect(
      createBody({
        ...emptyDraft('stdio'),
        name: 'Fichiers',
        url: 'ignored',
        command: ' npx -y @modelcontextprotocol/server-filesystem ~ ',
        secrets: [headerRow('GITHUB_TOKEN', ' ghp_1 ')],
        scope: { kind: 'bots', ids: ['bot-1'] },
      }),
    ).toEqual({
      name: 'Fichiers',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-filesystem ~',
      auth: 'none',
      secrets: { GITHUB_TOKEN: 'ghp_1' },
      scope: { kind: 'bots', ids: ['bot-1'] },
    });
  });

  it('checks the form before sending', () => {
    expect(draftProblem(remote({ name: ' ' }))).toBe('name');
    expect(draftProblem(remote({ url: 'github.com' }))).toBe('url');
    expect(draftProblem(remote({ auth: 'token' }))).toBe('token');
    expect(draftProblem(remote({ auth: 'token', token: 'a\nb' }))).toBe('token');
    expect(draftProblem(remote({ scope: { kind: 'teams', ids: [] } }))).toBe('scope');
    expect(draftProblem({ ...emptyDraft('stdio'), name: 'x' })).toBe('command');
    expect(draftProblem(remote())).toBeNull();
    // Editing a server whose token is stored: leaving it empty keeps it.
    const stored = mcpServer({ secretKeys: ['Authorization'] });
    expect(draftProblem(serverDraft(stored), stored)).toBeNull();
  });

  it('checks headers and variables', () => {
    expect(secretsProblem('http', [headerRow('X Bad', 'v')])).toBe('secretName');
    expect(secretsProblem('http', [headerRow('', 'orphan')])).toBe('secretName');
    expect(secretsProblem('http', [headerRow('X-Key', ' ')])).toBe('secretValue');
    expect(secretsProblem('http', [headerRow('X-Key', 'a\nb')])).toBe('secretValue');
    expect(secretsProblem('http', [headerRow('x-key', 'a'), headerRow('X-Key', 'b')])).toBe(
      'secretDuplicate',
    );
    // A token already sends Authorization.
    expect(
      draftProblem(
        remote({ auth: 'token', token: 't', secrets: [headerRow('authorization', 'x')] }),
      ),
    ).toBe('secretDuplicate');
    expect(secretsProblem('stdio', [headerRow('1TOKEN', 'v')])).toBe('secretName');
    expect(secretsProblem('stdio', [headerRow('token', 'a'), headerRow('TOKEN', 'b')])).toBeNull();
    expect(secretsProblem('stdio', [headerRow('API_KEY', 'multi\nline')])).toBeNull();
    expect(secretsProblem('stdio', [headerRow('', '')])).toBeNull();
  });

  it('sends only what the edit form changed', () => {
    const server = mcpServer({ name: 'GitHub', url: 'https://a.example/mcp', secretKeys: [] });
    expect(serverChanges(server, serverDraft(server))).toEqual({});
    expect(
      serverChanges(server, {
        ...serverDraft(server),
        name: 'GitHub Pro ',
        url: 'https://b.example/mcp',
        auth: 'token',
        token: 'ghp_9',
      }),
    ).toEqual({
      name: 'GitHub Pro',
      url: 'https://b.example/mcp',
      secrets: { Authorization: 'Bearer ghp_9' },
    });
    // Token to OAuth: the header goes, under the name it was stored with.
    const withToken = mcpServer({ secretKeys: ['authorization', 'X-Org'] });
    expect(serverChanges(withToken, { ...serverDraft(withToken), auth: 'oauth' })).toEqual({
      auth: 'oauth',
      secrets: { authorization: null },
    });
    expect(serverChanges(withToken, serverDraft(withToken))).toEqual({});
    const oauth = mcpServer({ auth: 'oauth' });
    expect(serverChanges(oauth, { ...serverDraft(oauth), auth: 'none' })).toEqual({
      auth: 'none',
    });
    const local = mcpServer({ transport: 'stdio', url: null, command: 'uvx mcp-server-time' });
    expect(
      serverChanges(local, { ...serverDraft(local), command: ' uvx mcp-server-time --local ' }),
    ).toEqual({ command: 'uvx mcp-server-time --local' });
  });

  it('replaces, adds and removes secrets from the server’s page', () => {
    expect(
      secretsPatch('http', { Authorization: ' tok ', 'X-Org': '' }, [headerRow('X-New', ' v ')]),
    ).toEqual({ Authorization: 'Bearer tok', 'X-New': 'v' });
    expect(secretsPatch('stdio', { TOKEN: 'abc' }, [])).toEqual({ TOKEN: 'abc' });
    expect(secretsPatch('http', {}, [])).toEqual({});
    expect(secretsPatchProblem('http', { 'X-Org': 'a\nb' }, [], ['X-Org'])).toBe('secretValue');
    expect(secretsPatchProblem('http', {}, [headerRow('x-org', 'v')], ['X-Org'])).toBe(
      'secretDuplicate',
    );
    expect(secretsPatchProblem('stdio', {}, [headerRow('NEW', 'v')], ['OLD'])).toBeNull();
    expect(removeSecretBody('X-Org')).toEqual({ secrets: { 'X-Org': null } });
  });
});

describe('mcp events', () => {
  it('keeps the servers live', () => {
    const client = new QueryClient();
    const first = mcpServer();
    client.setQueryData<McpServer[]>(keys.mcpServers, [first]);
    const changed = { ...first, status: 'error' as const };
    applyServerEvent(client, { type: 'mcp.updated', server: changed });
    const added = mcpServer({ name: 'Notion' });
    applyServerEvent(client, { type: 'mcp.updated', server: added });
    expect(client.getQueryData(keys.mcpServers)).toEqual([changed, added]);
    client.setQueryData(keys.mcpCalls(first.id), []);
    applyServerEvent(client, { type: 'mcp.deleted', serverId: first.id });
    expect(client.getQueryData(keys.mcpServers)).toEqual([added]);
    expect(client.getQueryData(keys.mcpCalls(first.id))).toBeUndefined();
  });

  it('refetches everything on reconnect', () => {
    const client = new QueryClient();
    client.setQueryData(keys.mcpServers, []);
    client.setQueryData(keys.mcpCalls('s'), []);
    applyServerEvent(client, { type: 'ready' });
    expect(client.getQueryState(keys.mcpServers)?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.mcpCalls('s'))?.isInvalidated).toBe(true);
  });
});
