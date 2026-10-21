import type { McpServer } from '@mowbot/contract';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api, apiBaseUrl } from './auth';

/** Every MCP server, oldest first (as the hub lists them); secret values never come back. */
export function useMcpServers() {
  return useQuery({
    queryKey: ['mcp'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/mcp/servers');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** The latest calls bots made to a server, newest first; no event announces them, so polled. */
export function useMcpCalls(serverId: string) {
  return useQuery({
    queryKey: ['mcp', serverId, 'calls'],
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/mcp/servers/{id}/calls', {
        params: { path: { id: serverId } },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** Puts a saved or refreshed server in the cache, and refreshes its calls. */
export function setMcpServer(queryClient: QueryClient, server: McpServer): void {
  queryClient.setQueryData<McpServer[]>(['mcp'], (list) => {
    if (!list) return list;
    return list.some((s) => s.id === server.id)
      ? list.map((s) => (s.id === server.id ? server : s))
      : [...list, server];
  });
  void queryClient.invalidateQueries({ queryKey: ['mcp', server.id] });
}

export function removeMcpServer(queryClient: QueryClient, serverId: string): void {
  queryClient.setQueryData<McpServer[]>(['mcp'], (list) => list?.filter((s) => s.id !== serverId));
}

/** The header a "token" is sent in: `Authorization: Bearer <token>`. */
export const TOKEN_HEADER = 'Authorization';

export const isTokenHeader = (key: string): boolean =>
  key.toLowerCase() === TOKEN_HEADER.toLowerCase();

/** A pasted token, with "Bearer " in front unless it already has it. */
export const bearer = (token: string): string =>
  /^bearer\s/i.test(token) ? token : `Bearer ${token}`;

/**
 * Starts signing in to an OAuth server in a new tab. The tab is opened on the click (a browser
 * only lets a click open one), then sent to the server's sign-in page, or closed when the hub
 * is already signed in. The server's status follows through `mcp.updated`.
 * Resolves to the sign-in page when no tab could be opened (blocked): show it as a link.
 */
export async function startMcpOAuth(serverId: string, tab: Window | null): Promise<string | null> {
  try {
    const { data, error } = await api.POST('/api/v1/mcp/servers/{id}/oauth/start', {
      params: { path: { id: serverId } },
      body: { redirectBase: apiBaseUrl || window.location.origin },
    });
    if (error || !data) throw error;
    if (data.authorizationUrl && tab) {
      tab.location.href = data.authorizationUrl;
      return null;
    }
    tab?.close();
    return data.authorizationUrl;
  } catch (caught) {
    tab?.close();
    throw caught;
  }
}

/** A blank tab that the sign-in page loads in; it cannot reach back into the app. */
export function openBlankTab(): Window | null {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  return tab;
}
