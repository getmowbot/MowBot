import type { McpServer } from '@mowbot/contract';
import { router } from 'expo-router';
import { Globe, Plug, Plus, SquareTerminal } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { Dot, LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { STATE_COLORS } from '../../../components/mcp/parts';
import { Screen } from '../../../components/screen';
import { Button, IconButton } from '../../../components/ui/button';
import { ICON_ROW_INSET, ListRow } from '../../../components/ui/rows';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import { type ScopeNames, serverHint, serverState, sortServers } from '../../../lib/mcp';
import { useMcpServers } from '../../../lib/mcp-queries';
import { useBots, useComputers, useTeams } from '../../../lib/queries';
import { colors } from '../../../theme';

type Names = ScopeNames & { computers: { id: string; name: string }[] | undefined };

function ServerRow({ server, names }: { server: McpServer; names: Names }) {
  const { t } = useTranslation();
  return (
    <ListRow
      icon={server.transport === 'http' ? Globe : SquareTerminal}
      label={server.name}
      hint={serverHint(server, names, t)}
      accessory={<Dot color={STATE_COLORS[serverState(server)]} />}
      onPress={() => router.push(`/mcp/${server.id}`)}
    />
  );
}

/** Remote services and local programs, and how bots get them. */
function EmptyServers({ onAdd }: { onAdd(): void }) {
  const { t } = useTranslation();
  return (
    <>
      <Surface style={styles.empty}>
        <Plug size={28} color={colors.textMuted} strokeWidth={1.8} />
        <T variant="headline">{t('mcp.emptyState.title')}</T>
        <T variant="footnote" tone="muted">
          {t('mcp.emptyState.remote')}
        </T>
        <T variant="footnote" tone="muted">
          {t('mcp.emptyState.local')}
        </T>
        <T variant="footnote" tone="muted">
          {t('mcp.emptyState.bots')}
        </T>
      </Surface>
      <Button label={t('mcp.add')} icon={Plus} onPress={onAdd} />
    </>
  );
}

/** MCP servers: services whose tools the bots get. */
export default function McpServersScreen() {
  const { t } = useTranslation();
  const servers = useMcpServers();
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();
  const list = sortServers(servers.data ?? []);
  const names: Names = { bots: bots.data, teams: teams.data, computers: computers.data };
  const add = () => router.push('/mcp/new');

  return (
    <Screen
      title={t('mcp.title')}
      headerRight={() => <IconButton icon={Plus} label={t('mcp.add')} onPress={add} />}
      onRefresh={() =>
        Promise.all([servers.refetch(), bots.refetch(), teams.refetch(), computers.refetch()])
      }
    >
      <Note>{t('mcp.intro')}</Note>
      {servers.isPending ? (
        <Loading />
      ) : servers.isError ? (
        <LoadError message={t('mcp.loadFailed')} onRetry={() => void servers.refetch()} />
      ) : list.length === 0 ? (
        <EmptyServers onAdd={add} />
      ) : (
        <ListCard inset={ICON_ROW_INSET}>
          {list.map((server) => (
            <ServerRow key={server.id} server={server} names={names} />
          ))}
        </ListCard>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 20, gap: 10 },
});
