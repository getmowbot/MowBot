import type { ServerEvent } from '@mowbot/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, client } from './auth';

const MAX_BACKOFF_MS = 30_000;

/** Keeps the React Query cache in sync with the hub's event stream while signed in. */
export function ServerEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case 'ready':
          // (Re)connected: whatever happened while offline is unknown, refetch.
          void queryClient.invalidateQueries({ queryKey: ['computer'] });
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'computer.updated':
          queryClient.setQueryData(['computer', event.computer.id], event.computer);
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'workspace.changed':
          void queryClient.invalidateQueries({ queryKey: ['files', event.workspaceId] });
          break;
      }
    };

    const reconnectLater = () => {
      if (stopped) return;
      timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt++));
    };

    async function connect() {
      const { data } = await api.POST('/api/v1/events/ticket').catch(() => ({ data: undefined }));
      if (stopped) return;
      if (!data) return reconnectLater();
      socket = new WebSocket(
        client.socketUrl(`/api/v1/events?ticket=${encodeURIComponent(data.ticket)}`),
      );
      socket.onopen = () => {
        attempt = 0;
      };
      socket.onmessage = (message) => handle(JSON.parse(message.data as string) as ServerEvent);
      socket.onclose = reconnectLater;
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient]);

  return null;
}
