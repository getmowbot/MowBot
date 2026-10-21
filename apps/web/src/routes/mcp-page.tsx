import type {
  McpAuth,
  McpServer,
  McpServerUpdate,
  McpStatus,
  McpTool,
  McpTransport,
} from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Globe,
  LogIn,
  type LucideIcon,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import {
  Choice,
  ScopePicker,
  sameScope,
  scopeDraft,
  scopeOf,
  useScopeLabel,
} from '../components/scope-picker';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { FormError, Input, Label, SecretInput } from '../components/ui/form';
import { Switch } from '../components/ui/switch';
import { i18n } from '../i18n';
import { api, problemMessage } from '../lib/auth';
import {
  bearer,
  isTokenHeader,
  openBlankTab,
  removeMcpServer,
  setMcpServer,
  startMcpOAuth,
  TOKEN_HEADER,
  useMcpCalls,
  useMcpServers,
} from '../lib/mcp';
import { Reveal, reveal, stagger } from '../lib/motion';
import { useBots, useComputers } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';

const TRANSPORT_ICON: Record<McpTransport, LucideIcon> = { http: Globe, stdio: SquareTerminal };
const TRANSPORTS: readonly McpTransport[] = ['http', 'stdio'];

/** How a remote server is signed in to: a token is an `Authorization: Bearer` secret header. */
type AuthMode = 'none' | 'token' | 'oauth';
const AUTH_MODES: readonly AuthMode[] = ['none', 'token', 'oauth'];

const STATUS_STYLE: Record<McpStatus, string> = {
  ok: 'border-primary/30 text-primary',
  error: 'border-destructive/30 text-destructive',
  needs_auth: 'border-warning/30 text-warning',
  unknown: 'border-border-strong text-muted-foreground',
};

/** What a stored value looks like: it never comes back from the hub. */
const MASKED = '••••••••';

/** The hub lists a new or changed server's tools in the background for about this long. */
const BACKGROUND_CONNECT_MS = 2 * 60_000;

/** A server to start from (the empty page's examples). */
interface Template {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  auth?: AuthMode;
  /** Secret names to fill in. */
  keys?: readonly string[];
}

const EXAMPLES: readonly { id: 'remote' | 'local'; template: Template }[] = [
  {
    id: 'remote',
    template: {
      name: 'Notion',
      transport: 'http',
      url: 'https://mcp.notion.com/mcp',
      auth: 'oauth',
    },
  },
  {
    id: 'local',
    template: {
      name: 'GitHub',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-github',
      keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    },
  },
];

const badgeStyle =
  'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10px] leading-4';

/** "340 ms", "1,2 s" in the app's language. */
function duration(ms: number): string {
  const seconds = ms >= 1_000;
  return new Intl.NumberFormat(i18n.language, {
    style: 'unit',
    unit: seconds ? 'second' : 'millisecond',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(seconds ? ms / 1_000 : ms);
}

/** "Installé par Iris sur PC Ventes" for a server a bot set up on its own computer. */
function useOriginLabel(server: McpServer): string | null {
  const { t } = useTranslation();
  const bots = useBots();
  const computers = useComputers();
  const { createdByBotId, computerId } = server;
  if (!createdByBotId && !computerId) return null;
  const bot =
    createdByBotId &&
    (bots.data?.find((b) => b.id === createdByBotId)?.name ??
      (bots.data ? t('mcp.deletedBot') : '…'));
  const pc =
    computerId &&
    (computers.data?.find((c) => c.id === computerId)?.name ??
      (computers.data ? t('mcp.deletedPc') : '…'));
  if (bot && pc) return t('mcp.installedBy', { bot, pc });
  if (bot) return t('mcp.addedBy', { bot });
  return t('mcp.onPc', { pc: pc || '' });
}

interface SecretRow {
  key: number;
  name: string;
  value: string;
}

let rowKey = 0;
const newRow = (name = ''): SecretRow => ({ key: rowKey++, name, value: '' });

/** New headers or environment variables: a name and a masked value per row. */
function SecretRows({
  rows,
  onChange,
  namePlaceholder,
  addLabel,
}: {
  rows: SecretRow[];
  onChange(rows: SecretRow[]): void;
  namePlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation();
  const set = (key: number, patch: Partial<SecretRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  return (
    <>
      <AnimatePresence initial={false}>
        {rows.map((row) => (
          <motion.div
            key={row.key}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
            className="overflow-hidden"
          >
            <div className="flex gap-2 pb-0.5">
              <Input
                value={row.name}
                onChange={(event) => set(row.key, { name: event.target.value })}
                placeholder={namePlaceholder}
                aria-label={t('mcp.secretName')}
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-[2] font-mono text-[13px]"
              />
              <div className="flex min-w-0 flex-[3]">
                <SecretInput
                  value={row.value}
                  onChange={(event) => set(row.key, { value: event.target.value })}
                  required={Boolean(row.name.trim())}
                  maxLength={10_000}
                  placeholder={t('mcp.valuePlaceholder')}
                  aria-label={t('mcp.secretValue', { name: row.name.trim() || '…' })}
                  className="font-mono text-[13px]"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => onChange(rows.filter((other) => other.key !== row.key))}
                aria-label={t('mcp.removeRow')}
              >
                <X className="size-4" />
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <Button variant="ghost" size="sm" onClick={() => onChange([...rows, newRow()])}>
        <Plus className="size-3.5" /> {addLabel}
      </Button>
    </>
  );
}

/** Values already stored: never shown; typing replaces one, "Retirer" removes it. */
function StoredSecrets({
  keys,
  replaced,
  removed,
  onReplace,
  onToggle,
}: {
  keys: string[];
  replaced: Record<string, string>;
  removed: ReadonlySet<string>;
  onReplace(key: string, value: string): void;
  onToggle(key: string): void;
}) {
  const { t } = useTranslation();
  return keys.map((key) => {
    const gone = removed.has(key);
    return (
      <div key={key} className="flex gap-2">
        <span
          title={key}
          className={cn(
            'flex h-10 min-w-0 flex-[2] items-center rounded-xl border border-border px-3 font-mono text-[13px]',
            gone ? 'text-faint line-through' : 'text-muted-foreground',
          )}
        >
          <span className="truncate">{key}</span>
        </span>
        <div className="flex min-w-0 flex-[3]">
          <SecretInput
            value={replaced[key] ?? ''}
            onChange={(event) => onReplace(key, event.target.value)}
            disabled={gone}
            maxLength={10_000}
            placeholder={
              gone ? t('mcp.willRemove') : t('mcp.replacePlaceholder', { masked: MASKED })
            }
            aria-label={t('mcp.replaceNamed', { name: key })}
            className="font-mono text-[13px]"
          />
        </div>
        <Button variant="ghost" className="h-10 shrink-0" onClick={() => onToggle(key)}>
          {gone ? t('mcp.keep') : t('mcp.remove')}
        </Button>
      </div>
    );
  });
}

/** Adds a server (from scratch or an example) or changes one; secret values stay write-only. */
function ServerForm({
  server,
  template,
  onDone,
}: {
  server?: McpServer;
  template?: Template;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const storedToken =
    server?.transport === 'http' ? server.secretKeys.find(isTokenHeader) : undefined;
  const [name, setName] = useState(server?.name ?? template?.name ?? '');
  const [transport, setTransport] = useState<McpTransport>(
    server?.transport ?? template?.transport ?? 'http',
  );
  const [url, setUrl] = useState(server?.url ?? template?.url ?? '');
  const [command, setCommand] = useState(server?.command ?? template?.command ?? '');
  const [authMode, setAuthMode] = useState<AuthMode>(() => {
    if (!server) return template?.auth ?? 'none';
    if (server.auth === 'oauth') return 'oauth';
    return storedToken ? 'token' : 'none';
  });
  const [token, setToken] = useState('');
  const [headers, setHeaders] = useState<SecretRow[]>([]);
  const [env, setEnv] = useState<SecretRow[]>(() =>
    (template?.keys ?? []).map((key) => newRow(key)),
  );
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState(() => scopeDraft(server?.scope ?? { kind: 'all', ids: [] }));
  const [error, setError] = useState<string | null>(null);

  const http = transport === 'http';
  const id = server ? `mcp-${server.id}` : 'mcp-new';
  const rows = http ? headers : env;
  const setRows = http ? setHeaders : setEnv;
  // The token has its own field; the other stored headers or variables are listed.
  const stored = server?.secretKeys.filter((key) => !http || !isTokenHeader(key)) ?? [];
  const auth: McpAuth = http && authMode === 'oauth' ? 'oauth' : 'none';
  /** Signing in again after saving: a new OAuth server, or one now elsewhere. */
  const signIn = auth === 'oauth' && (server?.auth !== 'oauth' || url.trim() !== server.url);

  const typedSecrets = (): Record<string, string> => {
    const secrets: Record<string, string> = {};
    for (const row of rows) if (row.name.trim()) secrets[row.name.trim()] = row.value;
    return secrets;
  };

  /** Only what changed: a new URL, command or secret makes the hub connect anew. */
  const patchOf = (current: McpServer): McpServerUpdate => {
    const patch: McpServerUpdate = {};
    if (name.trim() !== current.name) patch.name = name.trim();
    if (http && url.trim() !== current.url) patch.url = url.trim();
    if (!http && command.trim() !== current.command) patch.command = command.trim();
    if (http && auth !== current.auth) patch.auth = auth;
    const secrets: Record<string, string | null> = {};
    for (const key of removed) secrets[key] = null;
    for (const [key, value] of Object.entries(replaced)) {
      if (value.trim() && !removed.has(key)) secrets[key] = value;
    }
    Object.assign(secrets, typedSecrets());
    if (http && storedToken && (authMode !== 'token' || token.trim())) secrets[storedToken] = null;
    if (http && authMode === 'token' && token.trim()) secrets[TOKEN_HEADER] = bearer(token.trim());
    if (Object.keys(secrets).length > 0) patch.secrets = secrets;
    const next = scopeOf(scope);
    if (!sameScope(next, current.scope)) patch.scope = next;
    return patch;
  };

  const submit = useMutation({
    // The tab is opened on the click (browsers block it later), then sent to the sign-in page.
    mutationFn: async (_tab: Window | null): Promise<McpServer> => {
      if (server) {
        const body = patchOf(server);
        if (Object.keys(body).length === 0) return server;
        const { data, error } = await api.PATCH('/api/v1/mcp/servers/{id}', {
          params: { path: { id: server.id } },
          body,
        });
        if (error || !data) throw error;
        return data;
      }
      const secrets = typedSecrets();
      if (http && authMode === 'token' && token.trim())
        secrets[TOKEN_HEADER] = bearer(token.trim());
      const { data, error } = await api.POST('/api/v1/mcp/servers', {
        body: {
          name: name.trim(),
          transport,
          url: http ? url.trim() : undefined,
          command: http ? undefined : command.trim(),
          auth,
          secrets: Object.keys(secrets).length > 0 ? secrets : undefined,
          scope: scopeOf(scope),
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved, tab) => {
      setMcpServer(queryClient, saved);
      onDone();
      if (tab) {
        startMcpOAuth(saved.id, tab).catch((err) =>
          alert(problemMessage(err, i18n.t('mcp.signInFailed'))),
        );
      }
    },
    onError: (err, tab) => {
      tab?.close();
      setError(problemMessage(err, server ? t('mcp.notSaved') : t('mcp.notCreated')));
    },
  });

  const toggleRemoved = (key: string) =>
    setRemoved((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <form
      className="space-y-5"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        if (scope.kind !== 'all' && scope[scope.kind].length === 0) {
          setError(t('mcp.scopeEmpty'));
          return;
        }
        submit.mutate(signIn ? openBlankTab() : null);
      }}
    >
      {!server && (
        <Choice<McpTransport>
          id="transport"
          value={transport}
          onChange={setTransport}
          options={TRANSPORTS.map((value) => ({
            value,
            label: t(`mcp.transport.${value}`),
            hint: t(`mcp.transportHints.${value}`),
            icon: TRANSPORT_ICON[value],
          }))}
        />
      )}

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>{t('common.name')}</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={60}
          autoFocus={!server && !template}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={http ? 'Notion' : 'GitHub'}
        />
      </div>

      {http ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>{t('mcp.url')}</Label>
            <Input
              id={`${id}-url`}
              type="url"
              required
              maxLength={2_000}
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="font-mono text-[13px]"
            />
          </div>
          <div className="space-y-2">
            <p className="text-[13px] font-medium text-muted-foreground">{t('mcp.authLabel')}</p>
            <Choice<AuthMode>
              id="auth"
              value={authMode}
              onChange={setAuthMode}
              options={AUTH_MODES.map((mode) => ({
                value: mode,
                label: t(`mcp.auth.${mode}`),
                hint: t(`mcp.authHints.${mode}`),
              }))}
            />
            {authMode === 'token' && (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor={`${id}-token`}>{t('mcp.token')}</Label>
                <div className="flex">
                  <SecretInput
                    id={`${id}-token`}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    required={!storedToken}
                    maxLength={10_000}
                    placeholder={storedToken ? MASKED : t('mcp.tokenPlaceholder')}
                    className="font-mono text-[13px]"
                  />
                </div>
                <p className="text-xs text-faint">
                  {storedToken ? t('mcp.tokenKeep') : t('mcp.tokenHint')}
                </p>
              </div>
            )}
            {authMode === 'oauth' && <p className="text-xs text-faint">{t('mcp.oauthHint')}</p>}
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-command`}>{t('mcp.command')}</Label>
          <Input
            id={`${id}-command`}
            required
            maxLength={2_000}
            autoComplete="off"
            spellCheck={false}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-github"
            className="font-mono text-[13px]"
          />
          <p className="text-xs text-faint">
            {server?.computerId ? t('mcp.commandHintPc') : t('mcp.commandHint')}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div>
          <p className="text-[13px] font-medium text-muted-foreground">
            {http ? t('mcp.headers') : t('mcp.env')}
          </p>
          <p className="text-xs text-faint">{http ? t('mcp.headersHint') : t('mcp.envHint')}</p>
        </div>
        {stored.length > 0 && (
          <div className="space-y-2">
            <StoredSecrets
              keys={stored}
              replaced={replaced}
              removed={removed}
              onReplace={(key, value) => setReplaced((current) => ({ ...current, [key]: value }))}
              onToggle={toggleRemoved}
            />
          </div>
        )}
        <SecretRows
          rows={rows}
          onChange={setRows}
          namePlaceholder={http ? 'X-Api-Key' : 'API_KEY'}
          addLabel={http ? t('mcp.addHeader') : t('mcp.addEnv')}
        />
      </div>

      <ScopePicker value={scope} onChange={setScope} />

      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submit.isPending}>
          {signIn && <LogIn className="size-4" />}
          {submit.isPending
            ? t('common.saving')
            : signIn
              ? t('mcp.saveAndSignIn')
              : server
                ? t('common.save')
                : t('mcp.create')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function StatusBadge({ server, connecting }: { server: McpServer; connecting: boolean }) {
  const { t } = useTranslation();
  if (!server.enabled) {
    return (
      <span className={cn(badgeStyle, 'border-border-strong text-faint')}>{t('mcp.disabled')}</span>
    );
  }
  if (connecting) {
    return (
      <span className={cn(badgeStyle, 'border-border-strong')}>
        <span className="shimmer-text">{t('mcp.connecting')}</span>
      </span>
    );
  }
  return (
    <span className={cn(badgeStyle, STATUS_STYLE[server.status])}>
      {server.status === 'ok' && <Check className="size-3" />}
      {server.status === 'error' && <CircleAlert className="size-3" />}
      {t(`mcp.status.${server.status}`)}
    </span>
  );
}

/** A disclosure under a card: "12 outils ▾", "Derniers appels ▾". */
function Disclosure({
  open,
  onToggle,
  disabled,
  children,
}: {
  open: boolean;
  onToggle(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      disabled={disabled}
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:text-faint"
    >
      {children}
      {!disabled && (
        <ChevronDown
          className={cn('size-3.5 transition-transform duration-300', open && 'rotate-180')}
        />
      )}
    </button>
  );
}

function Expand({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={springs.soft}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  );
}

function ToolList({ tools }: { tools: McpTool[] }) {
  const { t } = useTranslation();
  return (
    <ul className="max-h-80 space-y-2.5 overflow-y-auto pb-1 pr-1 pt-3">
      {tools.map((tool) => {
        // The server's own hints (MCP annotations); some servers give none.
        const hint = tool.readOnly
          ? 'readOnly'
          : tool.destructive || tool.readOnly === false
            ? 'canModify'
            : null;
        return (
          <li key={tool.name} className="text-xs">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <code className="break-all font-mono text-[12px] text-foreground/90">
                {tool.name}
              </code>
              {hint && (
                <span
                  className={cn(
                    badgeStyle,
                    hint === 'readOnly'
                      ? 'border-border-strong text-muted-foreground'
                      : 'border-warning/30 text-warning',
                  )}
                >
                  {t(`mcp.${hint}`)}
                </span>
              )}
            </p>
            {tool.description && (
              <p title={tool.description} className="line-clamp-2 text-muted-foreground">
                {tool.description}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The latest calls bots made to the server, newest first. */
function CallList({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const calls = useMcpCalls(serverId);
  const bots = useBots();
  if (calls.isPending) return <p className="pt-3 text-xs text-faint">{t('common.loading')}</p>;
  if (calls.isError) return <p className="pt-3 text-xs text-destructive">{t('mcp.callsFailed')}</p>;
  if (calls.data.length === 0) {
    return <p className="pt-3 text-xs text-faint">{t('mcp.callsEmpty')}</p>;
  }
  return (
    <ul className="max-h-72 space-y-1.5 overflow-y-auto pb-1 pr-1 pt-3">
      {calls.data.map((call) => {
        const bot = call.botId ? bots.data?.find((b) => b.id === call.botId) : undefined;
        const who = call.botId ? (bot?.name ?? t('mcp.deletedBot')) : null;
        return (
          <li key={call.id} className="flex items-start gap-2 text-xs">
            {call.botId ? (
              <BotAvatar seed={bot?.avatarSeed ?? call.botId} size={16} />
            ) : (
              <span className="mx-[5px] mt-1.5 size-1.5 shrink-0 rounded-full bg-white/25" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-1.5">
                {who && <span className="shrink-0 text-foreground/90">{who}</span>}
                <code className="truncate font-mono text-muted-foreground">{call.tool}</code>
              </span>
              {call.error && (
                <span
                  title={call.error}
                  className="block truncate font-mono text-[11px] text-destructive/90"
                >
                  {call.error}
                </span>
              )}
            </span>
            <span
              title={call.ok ? t('mcp.callOk') : t('mcp.callFailed')}
              className={cn('mt-0.5 shrink-0', call.ok ? 'text-primary' : 'text-destructive')}
            >
              {call.ok ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
              <span className="sr-only">{call.ok ? t('mcp.callOk') : t('mcp.callFailed')}</span>
            </span>
            <span className="shrink-0 text-right text-faint">
              <span className="tabular-nums">{duration(call.durationMs)}</span>
              <span className="block text-[10px] sm:ml-1.5 sm:inline sm:text-xs">
                {timeAgo(call.createdAt)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ServerCard({ server, onEdit }: { server: McpServer; onEdit(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showTools, setShowTools] = useState(false);
  const [showCalls, setShowCalls] = useState(false);
  const scope = useScopeLabel(server.scope);
  const origin = useOriginLabel(server);
  const Icon = TRANSPORT_ICON[server.transport];
  const { name, tools } = server;

  const update = useMutation({
    mutationFn: async (body: McpServerUpdate) => {
      const { data, error } = await api.PATCH('/api/v1/mcp/servers/{id}', {
        params: { path: { id: server.id } },
        body,
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => setMcpServer(queryClient, updated),
  });
  // A failure shows as the server's status (and its detail), which the hub sets before answering.
  const refresh = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/mcp/servers/{id}/refresh', {
        params: { path: { id: server.id } },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => setMcpServer(queryClient, updated),
    onError: () => void queryClient.invalidateQueries({ queryKey: ['mcp'], exact: true }),
  });
  const connect = useMutation({
    mutationFn: (tab: Window | null) => startMcpOAuth(server.id, tab),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/mcp/servers/{id}', {
        params: { path: { id: server.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => removeMcpServer(queryClient, server.id),
  });
  const error = update.error ?? connect.error ?? remove.error;

  const connecting =
    refresh.isPending ||
    (server.status === 'unknown' &&
      server.enabled &&
      server.auth !== 'oauth' &&
      Date.now() - Date.parse(server.updatedAt) < BACKGROUND_CONNECT_MS);
  const needsSignIn =
    server.enabled &&
    server.auth === 'oauth' &&
    (server.status === 'needs_auth' || server.status === 'unknown');
  const meta = [
    scope,
    origin,
    server.secretKeys.length > 0 && t('mcp.secretCount', { count: server.secretKeys.length }),
    server.toolsAt && t('mcp.toolsAt', { time: timeAgo(server.toolsAt) }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <motion.li variants={reveal} className="glass rounded-2xl px-4 pb-2 pt-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-xl bg-white/[0.05]',
            !server.enabled && 'opacity-60',
          )}
        >
          <Icon className="size-4 text-muted-foreground" />
        </span>
        <div className={cn('min-w-0 flex-1 space-y-0.5', !server.enabled && 'opacity-60')}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{name}</span>
            <span className={cn(badgeStyle, 'border-border-strong text-muted-foreground')}>
              {t(`mcp.transport.${server.transport}`)}
            </span>
            <StatusBadge server={server} connecting={connecting} />
          </p>
          <p
            title={server.url ?? server.command ?? undefined}
            className="truncate font-mono text-xs text-muted-foreground"
          >
            {server.url ?? server.command}
          </p>
          {meta && <p className="text-xs text-faint">{meta}</p>}
          {server.enabled && server.status === 'error' && server.statusDetail && !connecting && (
            <p
              title={server.statusDetail}
              className="line-clamp-2 break-all pt-0.5 font-mono text-[11px] text-destructive/90"
            >
              {server.statusDetail}
            </p>
          )}
          {needsSignIn && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-2">
              <Button
                size="sm"
                onClick={() => connect.mutate(openBlankTab())}
                disabled={connect.isPending}
              >
                <LogIn className="size-3.5" /> {t('mcp.signIn')}
              </Button>
              {connect.data ? (
                // The browser blocked the tab: the sign-in page as a plain link.
                <a
                  href={connect.data}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-foreground underline underline-offset-2"
                >
                  {t('mcp.signInLink')} <ExternalLink className="size-3" />
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {connect.isSuccess ? t('mcp.signInOpened') : t('mcp.signInHint')}
                </span>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="pt-1 text-xs text-destructive">
              {problemMessage(error, t('common.actionFailed'))}
            </p>
          )}
        </div>
        <span className="pt-2">
          <Switch
            checked={server.enabled}
            onChange={() => update.mutate({ enabled: !server.enabled })}
            label={
              server.enabled ? t('mcp.disableNamed', { name }) : t('mcp.enableNamed', { name })
            }
          />
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-1 border-t border-border pt-1.5">
        <Disclosure
          open={showTools}
          onToggle={() => setShowTools((v) => !v)}
          disabled={tools.length === 0}
        >
          {tools.length > 0 ? t('mcp.toolCount', { count: tools.length }) : t('mcp.noTools')}
        </Disclosure>
        <Disclosure open={showCalls} onToggle={() => setShowCalls((v) => !v)}>
          {t('mcp.calls')}
        </Disclosure>
        <span className="ml-auto flex items-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            aria-label={t('mcp.refreshNamed', { name })}
            title={t('mcp.refresh')}
          >
            <RefreshCw className={cn('size-4', refresh.isPending && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onEdit}
            aria-label={t('mcp.editNamed', { name })}
            title={t('mcp.edit')}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => confirm(t('mcp.confirmDelete', { name })) && remove.mutate()}
            disabled={remove.isPending}
            aria-label={t('common.deleteNamed', { name })}
            title={t('common.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </span>
      </div>

      <AnimatePresence initial={false}>
        {showTools && tools.length > 0 && (
          <Expand key="tools">
            <ToolList tools={tools} />
          </Expand>
        )}
        {showCalls && (
          <Expand key="calls">
            <CallList serverId={server.id} />
          </Expand>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

/** No server yet: what MCP brings, and two examples that fill the form in. */
function EmptyMcp({ onPick }: { onPick(template: Template): void }) {
  const { t } = useTranslation();
  return (
    <Reveal
      delay={0.05}
      className="rounded-2xl border border-dashed border-border-strong px-6 py-8"
    >
      <p className="text-center font-medium">{t('mcp.emptyTitle')}</p>
      <p className="mx-auto mt-1 max-w-md text-center text-sm text-muted-foreground">
        {t('mcp.emptyHint')}
      </p>
      <div className="mx-auto mt-5 grid max-w-xl gap-3 sm:grid-cols-2">
        {EXAMPLES.map(({ id, template }) => {
          const Icon = TRANSPORT_ICON[template.transport];
          return (
            <button
              key={id}
              type="button"
              onClick={() => onPick(template)}
              className="min-w-0 rounded-xl border border-border-strong px-4 py-3 text-left transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.03]"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {t(`mcp.examples.${id}`)}
              </span>
              <code className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground">
                {template.url ?? template.command}
              </code>
              <span className="mt-1 block text-xs text-faint">{t(`mcp.examples.${id}Hint`)}</span>
            </button>
          );
        })}
      </div>
    </Reveal>
  );
}

/** MCP servers: services plugged into the bots, whose tools become theirs. */
export function McpPage() {
  const { t } = useTranslation();
  const servers = useMcpServers();
  const [adding, setAdding] = useState(false);
  const [template, setTemplate] = useState<Template | undefined>();
  const [editId, setEditId] = useState<string | null>(null);
  const list = servers.data ?? [];
  const editing = list.find((server) => server.id === editId);
  const EditingIcon = editing ? TRANSPORT_ICON[editing.transport] : null;
  const add = (from?: Template) => {
    setTemplate(from);
    setAdding(true);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('shell.mcp')}</h1>
          <p className="text-sm text-muted-foreground">{t('mcp.subtitle')}</p>
        </div>
        <Button onClick={() => add()}>
          <Plus className="size-4" /> {t('mcp.add')}
        </Button>
      </Reveal>

      {servers.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {servers.isError && <p className="text-sm text-destructive">{t('mcp.loadFailed')}</p>}
      {servers.isSuccess && list.length === 0 && <EmptyMcp onPick={add} />}

      {list.length > 0 && (
        <motion.ul initial="hidden" animate="shown" variants={stagger} className="space-y-3">
          {list.map((server) => (
            <ServerCard key={server.id} server={server} onEdit={() => setEditId(server.id)} />
          ))}
        </motion.ul>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        className="max-w-xl"
        title={t('mcp.addTitle')}
        description={t('mcp.addHint')}
      >
        <ServerForm
          key={template?.name ?? 'blank'}
          template={template}
          onDone={() => setAdding(false)}
        />
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onClose={() => setEditId(null)}
        className="max-w-xl"
        title={
          editing && EditingIcon ? (
            <span className="flex items-center gap-2.5">
              <EditingIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{editing.name}</span>
            </span>
          ) : (
            ''
          )
        }
        description={editing && t(`mcp.transport.${editing.transport}`)}
      >
        {editing && <ServerForm key={editing.id} server={editing} onDone={() => setEditId(null)} />}
      </Dialog>
    </div>
  );
}
