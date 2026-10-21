import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Loading, Note } from '../../../../components/admin/parts';
import { McpEditor } from '../../../../components/mcp/editor';
import { Screen } from '../../../../components/screen';
import { useMcpServer } from '../../../../lib/mcp-queries';

/** Changes a server's name, address or command, and how it signs in. */
export default function EditMcpServerScreen() {
  const { t } = useTranslation();
  const { serverId } = useLocalSearchParams<{ serverId: string }>();
  const server = useMcpServer(serverId);
  return (
    <Screen title={t('mcp.form.editTitle')}>
      {server.isPending ? (
        <Loading />
      ) : server.data ? (
        <McpEditor key={server.data.id} server={server.data} onDone={() => router.back()} />
      ) : (
        <Note>{t('mcp.notFound')}</Note>
      )}
    </Screen>
  );
}
