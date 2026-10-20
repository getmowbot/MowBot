import type { Bot, Message, ServerEvent } from '@mowbot/contract';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, client } from './auth';

const MAX_BACKOFF_MS = 30_000;

function upsertMessage(queryClient: QueryClient, message: Message) {
  queryClient.setQueryData<Message[]>(['messages', message.botId], (list) => {
    if (!list) return list;
    const index = list.findIndex((m) => m.id === message.id);
    if (index < 0) return [...list, message];
    const next = list.slice();
    next[index] = message;
    return next;
  });
}

function appendDelta(
  queryClient: QueryClient,
  event: Extract<ServerEvent, { type: 'message.delta' }>,
) {
  queryClient.setQueryData<Message[]>(['messages', event.botId], (list) => {
    if (!list) return list;
    return list.map((message) => {
      if (message.id !== event.messageId) return message;
      const parts = message.parts.slice();
      const part = parts[event.partIndex];
      if (part && part.type === event.kind) {
        parts[event.partIndex] = { ...part, text: part.text + event.text };
      } else {
        parts[event.partIndex] = { type: event.kind, text: event.text };
      }
      return { ...message, parts };
    });
  });
}

function updateBot(queryClient: QueryClient, bot: Bot) {
  queryClient.setQueryData<Bot[]>(['bots'], (list) =>
    list ? list.map((b) => (b.id === bot.id ? bot : b)) : list,
  );
}

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
          for (const key of ['computer', 'computers', 'bots', 'messages']) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          }
          break;
        case 'computer.updated':
          queryClient.setQueryData(['computer', event.computer.id], event.computer);
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'workspace.changed':
          void queryClient.invalidateQueries({ queryKey: ['files', event.workspaceId] });
          break;
        case 'bot.updated':
          updateBot(queryClient, event.bot);
          break;
        case 'message.updated':
          upsertMessage(queryClient, event.message);
          break;
        case 'message.delta':
          appendDelta(queryClient, event);
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
