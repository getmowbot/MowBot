import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { McpEditor } from '../../../components/mcp/editor';
import { Screen } from '../../../components/screen';

/** Adds a remote or a local MCP server. */
export default function NewMcpServerScreen() {
  const { t } = useTranslation();
  return (
    <Screen title={t('mcp.form.newTitle')}>
      {/* On to its page: its status, its tools as they get listed, signing in for OAuth. */}
      <McpEditor onDone={(server) => router.replace(`/mcp/${server.id}`)} />
    </Screen>
  );
}
