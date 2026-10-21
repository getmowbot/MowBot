import type { Bot, Computer, McpServer, Team } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowRightLeft, Check, LogIn, Pencil, RefreshCw, Trash2, X } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { Caption, Dot, FormError, LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import {
  AccessBadge,
  ScopePicker,
  SecretPairs,
  STATE_COLORS,
  STATE_ICONS,
} from '../../../components/mcp/parts';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ICON_ROW_INSET, ListRow, ROW_INSET, SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { SECRET_INPUT } from '../../../components/vault/parts';
import {
  authChoice,
  callHint,
  installedText,
  isAuthorization,
  isLegacy,
  liveScope,
  removeSecretBody,
  type ScopeNames,
  sameScope,
  scopeProblem,
  secretsPatch,
  secretsPatchProblem,
  serverState,
  statusText,
  toolAccess,
  transportLabel,
} from '../../../lib/mcp';
import {
  isConnectionProblem,
  mcpError,
  useDeleteMcpServer,
  useMcpCalls,
  useMcpServer,
  useMoveMcpServer,
  useRefreshMcpServer,
  useStartMcpOAuth,
  useUpdateMcpServer,
} from '../../../lib/mcp-queries';
import { alertError, confirm, showInfo } from '../../../lib/options-menu';
import type { HeaderRow } from '../../../lib/provider-form';
import { botsById, keys, useBots, useComputers, useTeams } from '../../../lib/queries';
import { hubUrl } from '../../../lib/session';
import { timeAgo } from '../../../lib/time';
import { computerName } from '../../../lib/vault';
import { colors, spacing } from '../../../theme';

const TOOLS_SHOWN = 10;
const CALLS_SHOWN = 10;

/** Connected or not and why, refresh, sign in (OAuth), on / off. */
function Status({ server }: { server: McpServer }) {
  const { t, i18n } = useTranslation();
  const refresh = useRefreshMcpServer();
  const oauth = useStartMcpOAuth();
  const toggle = useUpdateMcpServer();
  // The switch follows the tap right away, then the hub's answer.
  const pending = toggle.isPending ? toggle.variables?.body.enabled : undefined;
  const enabled = pending ?? server.enabled;
  const state = serverState(server);
  const text = statusText(server, t, i18n.language);
  const oauthServer = server.transport === 'http' && server.auth === 'oauth';
  const spinner = <ActivityIndicator size="small" color={colors.textMuted} />;

  const reconnect = () =>
    refresh.mutate(server.id, {
      onError: (err) => {
        // Unreachable, or a sign-in needed: the status above now says so.
        if (!isConnectionProblem(err)) alertError(mcpError(err, t('common.actionFailed')));
      },
    });

  const signIn = () => {
    const base = hubUrl();
    if (!base) return;
    // The service sends the browser back to the hub this phone talks to, which shows "Connected".
    oauth.mutate(
      { id: server.id, redirectBase: base },
      {
        onSuccess: (url) => {
          if (!url) {
            showInfo(t('mcp.actions.signedIn'));
            return;
          }
          Linking.openURL(url).catch(() => alertError(t('common.actionFailed')));
        },
        onError: (err) => alertError(mcpError(err, t('common.actionFailed'))),
      },
    );
  };

  const setEnabled = (next: boolean) =>
    toggle.mutate(
      { id: server.id, body: { enabled: next } },
      { onError: (err) => alertError(mcpError(err, t('mcp.form.notSaved'))) },
    );

  return (
    <Section title={t('mcp.actions.title')}>
      <ListCard inset={ICON_ROW_INSET}>
        <ListRow
          icon={STATE_ICONS[state]}
          label={text.label}
          hint={text.hint}
          accessory={<Dot color={STATE_COLORS[state]} />}
        />
        {oauthServer && state !== 'needsAuth' ? (
          <ListRow
            icon={LogIn}
            label={t('mcp.actions.signInAgain')}
            hint={t('mcp.actions.signInHint')}
            chevron={false}
            disabled={oauth.isPending || !server.enabled}
            accessory={oauth.isPending ? spinner : undefined}
            onPress={signIn}
          />
        ) : null}
        <ListRow
          icon={RefreshCw}
          label={t('mcp.actions.refresh')}
          hint={t('mcp.actions.refreshHint')}
          chevron={false}
          disabled={refresh.isPending || !server.enabled}
          accessory={refresh.isPending ? spinner : undefined}
          onPress={reconnect}
        />
      </ListCard>
      {oauthServer && state === 'needsAuth' ? (
        <>
          <Button
            label={t('mcp.actions.signIn')}
            icon={LogIn}
            onPress={signIn}
            loading={oauth.isPending}
          />
          <Caption>{t('mcp.actions.signInHint')}</Caption>
        </>
      ) : null}
      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('mcp.actions.enabled')}
          hint={t('mcp.actions.enabledHint')}
          value={enabled}
          onChange={setEnabled}
          disabled={toggle.isPending}
        />
      </ListCard>
    </Section>
  );
}

interface Names extends ScopeNames {
  bots: Bot[];
  teams: Team[];
  computers: Computer[] | undefined;
}

/**
 * Remote or local (and where it runs), its address or command, how it signs in, its tools'
 * prefix, who added it; a server a bot installed on its own PC can move to the MCP computer.
 */
function Info({ server, names }: { server: McpServer; names: Names }) {
  const { t } = useTranslation();
  const move = useMoveMcpServer();
  const installed = installedText(server, names, t);
  const legacy = isLegacy(server);

  const askMove = async () => {
    const ok = await confirm(
      t('mcp.move.confirm', { name: server.name }),
      t('mcp.move.confirmHint'),
      {
        label: t('mcp.move.action'),
      },
    );
    if (!ok) return;
    move.mutate(server.id, { onError: (err) => alertError(mcpError(err, t('mcp.move.notMoved'))) });
  };
  return (
    <Section title={t('mcp.info.title')}>
      <ListCard inset={ROW_INSET}>
        <ListRow label={t('mcp.info.kind')} value={transportLabel(server.transport, t)} />
        {server.transport === 'http' ? (
          <>
            <ListRow label={t('mcp.info.url')} hint={server.url ?? '—'} />
            <ListRow label={t('mcp.info.auth')} value={t(`mcp.auth.${authChoice(server)}`)} />
          </>
        ) : (
          <>
            <ListRow label={t('mcp.info.command')} hint={server.command ?? '—'} />
            <ListRow
              label={t('mcp.info.where')}
              value={
                server.computerId
                  ? computerName(server.computerId, names.computers, t)
                  : t('mcp.info.mcpPc')
              }
            />
          </>
        )}
        <ListRow
          label={t('mcp.info.prefix')}
          hint={t('mcp.info.prefixHint', { prefix: `mcp__${server.slug}__` })}
        />
      </ListCard>
      {installed ? <Caption>{installed}</Caption> : null}
      {legacy ? (
        <>
          <Button
            label={t('mcp.move.action')}
            icon={ArrowRightLeft}
            variant="secondary"
            onPress={() => void askMove()}
            loading={move.isPending}
          />
          <Caption>{t('mcp.move.hint')}</Caption>
        </>
      ) : null}
    </Section>
  );
}

/** All bots, some teams or some bots, saved with its own button. */
function Scope({ server, names }: { server: McpServer; names: Names }) {
  const { t } = useTranslation();
  const save = useUpdateMcpServer();
  const { bots, teams, computers } = names;
  const [base, setBase] = useState(server.scope);
  const [scope, setScope] = useState(server.scope);
  const [error, setError] = useState<string | null>(null);
  // Teams and bots deleted since are neither shown nor sent back.
  const next = liveScope(scope, names);
  const dirty = !sameScope(next, liveScope(server.scope, names));

  // Changed elsewhere (another device, a bot) or just saved: follow it unless being edited.
  if (base !== server.scope) {
    if (!dirty) setScope(server.scope);
    setBase(server.scope);
  }

  const submit = () => {
    if (scopeProblem(next)) {
      setError(t('mcp.formProblems.scope'));
      return;
    }
    setError(null);
    save.mutate(
      { id: server.id, body: { scope: next } },
      {
        onSuccess: (saved) => setScope(saved.scope),
        onError: (err) => setError(mcpError(err, t('mcp.scope.notSaved'))),
      },
    );
  };

  return (
    <Section title={t('mcp.scope.title')}>
      <ScopePicker
        scope={next}
        onChange={(changed) => {
          setScope(changed);
          setError(null);
        }}
        bots={bots}
        teams={teams}
      />
      {server.computerId ? (
        <Caption>
          {t('mcp.scope.computerNote', { pc: computerName(server.computerId, computers, t) })}
        </Caption>
      ) : server.transport === 'stdio' ? (
        <Caption>{t('mcp.scope.localNote')}</Caption>
      ) : null}
      <FormError message={error} />
      {dirty ? <Button label={t('common.save')} onPress={submit} loading={save.isPending} /> : null}
    </Section>
  );
}

/** Stored headers or variables (replaced when typed, removed one by one), and new ones. */
function Secrets({ server }: { server: McpServer }) {
  const { t } = useTranslation();
  const save = useUpdateMcpServer();
  const remove = useUpdateMcpServer();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { transport, secretKeys } = server;
  const remote = transport === 'http';
  // A key removed meanwhile (another device) is not sent back.
  const replaced = Object.fromEntries(
    Object.entries(typed).filter(([key]) => secretKeys.includes(key)),
  );
  const patch = secretsPatch(transport, replaced, added);
  const dirty = Object.keys(patch).length > 0;

  const submit = () => {
    const problem = secretsPatchProblem(transport, replaced, added, secretKeys);
    if (problem) {
      setError(t(`mcp.formProblems.${problem}`));
      return;
    }
    setError(null);
    save.mutate(
      { id: server.id, body: { secrets: patch } },
      {
        onSuccess: () => {
          setTyped({});
          setAdded([]);
        },
        onError: (err) => setError(mcpError(err, t('mcp.secrets.notSaved'))),
      },
    );
  };

  const askRemove = async (key: string) => {
    const ok = await confirm(t('mcp.secrets.removeConfirm', { key }), t('mcp.secrets.removeHint'), {
      label: t('mcp.secrets.removeAction'),
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(
      { id: server.id, body: removeSecretBody(key) },
      { onError: (err) => alertError(mcpError(err, t('common.actionFailed'))) },
    );
  };

  return (
    <Section title={remote ? t('mcp.secrets.headers') : t('mcp.secrets.env')}>
      {secretKeys.length === 0 ? (
        <Note>{remote ? t('mcp.secrets.noneHeaders') : t('mcp.secrets.noneEnv')}</Note>
      ) : (
        <>
          <Note>{t('mcp.secrets.note')}</Note>
          <View style={styles.fields}>
            {secretKeys.map((key) => (
              <Field
                key={key}
                label={key}
                value={typed[key] ?? ''}
                onChangeText={(value) => setTyped((current) => ({ ...current, [key]: value }))}
                placeholder={t('mcp.secrets.stored')}
                hint={
                  remote && isAuthorization(key) ? t('mcp.secrets.authorizationHint') : undefined
                }
                secureTextEntry
                maxLength={10_000}
                {...SECRET_INPUT}
              />
            ))}
          </View>
          <ListCard inset={ICON_ROW_INSET}>
            {secretKeys.map((key) => (
              <ListRow
                key={key}
                icon={X}
                label={t('mcp.secrets.remove', { key })}
                destructive
                disabled={remove.isPending}
                onPress={() => void askRemove(key)}
              />
            ))}
          </ListCard>
        </>
      )}
      <SecretPairs transport={transport} rows={added} onChange={setAdded} />
      <FormError message={error} />
      {dirty ? <Button label={t('common.save')} onPress={submit} loading={save.isPending} /> : null}
    </Section>
  );
}

/** What the server offers, as it describes each tool. */
function Tools({ server }: { server: McpServer }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const { tools } = server;
  const shown = all ? tools : tools.slice(0, TOOLS_SHOWN);

  return (
    <Section
      title={t('mcp.tools.title')}
      accessory={
        tools.length > 0 ? (
          <T variant="caption" tone="faint">
            {tools.length}
          </T>
        ) : undefined
      }
    >
      {tools.length === 0 ? (
        <Note>{server.toolsAt ? t('mcp.tools.none') : t('mcp.tools.noneYet')}</Note>
      ) : (
        <ListCard inset={ROW_INSET}>
          {shown.map((tool) => {
            const access = toolAccess(tool);
            return (
              <ListRow
                key={tool.name}
                label={tool.name}
                hint={tool.description ?? undefined}
                accessory={access ? <AccessBadge access={access} /> : undefined}
              />
            );
          })}
          {tools.length > TOOLS_SHOWN && (
            <ListRow
              key="more"
              label={
                all ? t('mcp.tools.showLess') : t('mcp.tools.showAll', { count: tools.length })
              }
              chevron={false}
              onPress={() => setAll((value) => !value)}
            />
          )}
        </ListCard>
      )}
    </Section>
  );
}

/** The latest calls bots made: which bot, which tool, how long, what failed. */
function Calls({ server, bots }: { server: McpServer; bots: Map<string, Bot> }) {
  const { t, i18n } = useTranslation();
  const calls = useMcpCalls(server.id);
  const [all, setAll] = useState(false);
  const list = calls.data ?? [];
  const shown = all ? list : list.slice(0, CALLS_SHOWN);

  return (
    <Section title={t('mcp.calls.title')}>
      {calls.isPending ? (
        <Loading />
      ) : calls.isError ? (
        <LoadError onRetry={() => void calls.refetch()} />
      ) : list.length === 0 ? (
        <Note>{t('mcp.calls.none')}</Note>
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {shown.map((call) => (
            <ListRow
              key={call.id}
              icon={call.ok ? Check : X}
              label={call.tool}
              hint={callHint(call, bots, t, i18n.language)}
              value={timeAgo(call.createdAt, t, i18n.language)}
              destructive={!call.ok}
            />
          ))}
          {list.length > CALLS_SHOWN && (
            <ListRow
              key="more"
              label={all ? t('mcp.calls.showLess') : t('mcp.calls.showAll', { count: list.length })}
              chevron={false}
              onPress={() => setAll((value) => !value)}
            />
          )}
        </ListCard>
      )}
    </Section>
  );
}

function McpDetail({
  server,
  bots,
  teams,
  computers,
}: {
  server: McpServer;
  bots: Bot[];
  teams: Team[];
  computers: Computer[] | undefined;
}) {
  const { t } = useTranslation();
  const remove = useDeleteMcpServer();
  const names: Names = { bots, teams, computers };

  const askDelete = async () => {
    const ok = await confirm(t('mcp.confirmDelete', { name: server.name }), t('mcp.deleteHint'), {
      label: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(server.id, {
      onSuccess: () => router.back(),
      onError: (err) => alertError(mcpError(err, t('common.actionFailed'))),
    });
  };

  return (
    <>
      <Status server={server} />
      <Info server={server} names={names} />
      <Scope server={server} names={names} />
      <Tools server={server} />
      <Secrets server={server} />
      <Calls server={server} bots={botsById(bots)} />
      <FormActions>
        <Button
          label={t('mcp.delete')}
          icon={Trash2}
          variant="danger"
          loading={remove.isPending}
          onPress={() => void askDelete()}
        />
      </FormActions>
    </>
  );
}

/** One MCP server: status, connection, bots, tools, secrets, recent calls, delete. */
export default function McpServerScreen() {
  const { t } = useTranslation();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const client = useQueryClient();
  const server = useMcpServer(serverId);
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();
  const data = server.data;

  return (
    <Screen
      title={data?.name ?? t('mcp.title')}
      headerRight={
        data
          ? () => (
              <IconButton
                icon={Pencil}
                label={t('mcp.form.editTitle')}
                onPress={() => router.push(`/mcp/edit/${data.id}`)}
              />
            )
          : undefined
      }
      onRefresh={() =>
        Promise.all([
          server.refetch(),
          bots.refetch(),
          teams.refetch(),
          computers.refetch(),
          client.invalidateQueries({ queryKey: keys.mcpCalls(serverId) }),
        ])
      }
    >
      {server.isPending ? (
        <Loading />
      ) : server.isError ? (
        <LoadError message={t('mcp.loadFailed')} onRetry={() => void server.refetch()} />
      ) : data ? (
        <McpDetail
          key={data.id}
          server={data}
          bots={bots.data ?? []}
          teams={teams.data ?? []}
          computers={computers.data}
        />
      ) : (
        <Note>{t('mcp.notFound')}</Note>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fields: { gap: spacing.lg },
});
