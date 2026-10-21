import type { McpServer, McpServerCreate, McpServerUpdate } from '@mowbot/contract';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import i18n from '../i18n';
import { problemCode } from './hub-url';
import { data, keys } from './queries';
import { api } from './session';

/** Hub problems worded in the app's language; the others fall back to a generic message. */
const WORDED = [
  'mcp_url_required',
  'mcp_command_required',
  'mcp_not_oauth',
  'mcp_not_legacy',
  'mcp_needs_auth',
  'mcp_unreachable',
  'mcp_oauth_state',
  'mcp_oauth_failed',
  'not_found',
] as const;

/** The message to show for a failed MCP action. */
export function mcpError(error: unknown, fallback: string): string {
  const code = problemCode(error);
  if (code === 'validation_failed' || code === 'rate_limited') return i18n.t(`errors.${code}`);
  if (code && (WORDED as readonly string[]).includes(code)) {
    return i18n.t(`mcp.problems.${code as (typeof WORDED)[number]}`);
  }
  return fallback;
}

/** Connecting failed: the server's status (and its reason) already says so on its page. */
export function isConnectionProblem(error: unknown): boolean {
  const code = problemCode(error);
  return code === 'mcp_unreachable' || code === 'mcp_needs_auth';
}

async function noContent(call: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await call;
  if (error !== undefined) throw error;
}

/** Replaces the server with the same id, or appends it. */
function putServer(client: QueryClient, server: McpServer) {
  client.setQueryData<McpServer[]>(keys.mcpServers, (list) => {
    if (!list) return list;
    return list.some((x) => x.id === server.id)
      ? list.map((x) => (x.id === server.id ? server : x))
      : [...list, server];
  });
}

/** Every server, without its secrets (kept live by `mcp.updated` / `mcp.deleted`). */
export function useMcpServers() {
  return useQuery({
    queryKey: keys.mcpServers,
    queryFn: async () => (await data(api().GET('/api/v1/mcp/servers'))).items,
  });
}

export function useMcpServer(serverId: string | undefined) {
  const servers = useMcpServers();
  return { ...servers, data: servers.data?.find((server) => server.id === serverId) };
}

/** The latest calls bots made to a server, newest first. */
export function useMcpCalls(serverId: string | undefined) {
  return useQuery({
    queryKey: keys.mcpCalls(serverId ?? ''),
    enabled: Boolean(serverId),
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/mcp/servers/{id}/calls', {
            params: { path: { id: serverId as string } },
          }),
        )
      ).items,
  });
}

/** Adds a server; the hub lists its tools in the background (followed by events). */
export function useCreateMcpServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: McpServerCreate) => data(api().POST('/api/v1/mcp/servers', { body })),
    onSuccess: (server) => putServer(client, server),
  });
}

/** Name, address, sign-in, secrets (replaced when typed, removed when null), bots, on / off. */
export function useUpdateMcpServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: McpServerUpdate }) =>
      data(api().PATCH('/api/v1/mcp/servers/{id}', { params: { path: { id } }, body })),
    onSuccess: (server) => putServer(client, server),
  });
}

export function useDeleteMcpServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      noContent(api().DELETE('/api/v1/mcp/servers/{id}', { params: { path: { id } } })),
    onSuccess: (_, id) => {
      client.setQueryData<McpServer[]>(keys.mcpServers, (list) => list?.filter((s) => s.id !== id));
      client.removeQueries({ queryKey: keys.mcpCalls(id) });
    },
  });
}

/** Puts a server a bot installed on its own PC on the MCP computer (its tools are read again). */
export function useMoveMcpServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      data(api().POST('/api/v1/mcp/servers/{id}/move', { params: { path: { id } } })),
    onSuccess: (server) => putServer(client, server),
  });
}

/** Connects again and lists the tools (a local server starts on the MCP computer: it may take a while). */
export function useRefreshMcpServer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      data(api().POST('/api/v1/mcp/servers/{id}/refresh', { params: { path: { id } } })),
    onSuccess: (server) => putServer(client, server),
    // Its status now says why (also sent as an event, in case it was missed).
    onError: () => void client.invalidateQueries({ queryKey: keys.mcpServers }),
  });
}

/**
 * Starts signing in to an OAuth server: the page to open in the browser, which comes back to the
 * hub this app is connected to (null: already signed in, its tools were read again).
 */
export function useStartMcpOAuth() {
  return useMutation({
    mutationFn: async ({ id, redirectBase }: { id: string; redirectBase: string }) =>
      (
        await data(
          api().POST('/api/v1/mcp/servers/{id}/oauth/start', {
            params: { path: { id } },
            body: { redirectBase },
          }),
        )
      ).authorizationUrl,
  });
}
