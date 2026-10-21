import type {
  Automation,
  Bot,
  Canvas,
  Message,
  Question,
  ServerEvent,
  Team,
  VaultItem,
} from '@mowbot/contract';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, client } from './auth';
import { alertOnThisDevice } from './proactivity';
import { setVaultItem } from './vault';

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

/** Replaces the item with the same id, or appends it (created elsewhere: another device, a bot). */
function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

function updateBot(queryClient: QueryClient, bot: Bot) {
  queryClient.setQueryData<Bot[]>(['bots'], (list) => upsert(list, bot));
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
          for (const key of [
            'computer',
            'computers',
            'bots',
            'messages',
            'teams',
            'tasks',
            'feed',
            'canvases',
            'notifications',
            'routines',
            'automations',
            'system',
            'vault',
          ]) {
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
          // A new bot may come with a new PC.
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'bot.deleted':
          queryClient.setQueryData<Bot[]>(['bots'], (list) =>
            list?.filter((b) => b.id !== event.botId),
          );
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'team.updated':
          queryClient.setQueryData<Team[]>(['teams'], (list) => upsert(list, event.team));
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'team.deleted':
          queryClient.setQueryData<Team[]>(['teams'], (list) =>
            list?.filter((t) => t.id !== event.teamId),
          );
          void queryClient.invalidateQueries({ queryKey: ['computers'] });
          break;
        case 'task.updated':
          void queryClient.invalidateQueries({ queryKey: ['tasks'] });
          break;
        case 'messages.cleared':
          queryClient.setQueryData<Message[]>(['messages', event.botId], []);
          break;
        case 'message.updated':
          upsertMessage(queryClient, event.message);
          if (event.message.fromBotId) void queryClient.invalidateQueries({ queryKey: ['feed'] });
          break;
        case 'message.delta':
          appendDelta(queryClient, event);
          break;
        case 'message.deleted':
          queryClient.setQueryData<Message[]>(['messages', event.botId], (list) =>
            list?.filter((m) => m.id !== event.messageId),
          );
          break;
        case 'canvas.updated':
          queryClient.setQueryData<Canvas[]>(['canvases'], (list) =>
            list ? upsert(list, event.canvas)?.sort((a, b) => a.position - b.position) : list,
          );
          break;
        case 'canvas.deleted':
          queryClient.setQueryData<Canvas[]>(['canvases'], (list) =>
            list?.filter((c) => c.id !== event.canvasId),
          );
          break;
        case 'notification.created':
          void queryClient.invalidateQueries({ queryKey: ['notifications'] });
          alertOnThisDevice(event.notification);
          break;
        case 'notifications.cleared':
          queryClient.setQueryData(['notifications'], { items: [], unread: 0 });
          break;
        case 'activity.cleared':
          void queryClient.invalidateQueries({ queryKey: ['tasks'] });
          void queryClient.invalidateQueries({ queryKey: ['feed'] });
          break;
        case 'vault.updated':
          setVaultItem(queryClient, event.item);
          // A saved session shows as "already saved" in its computer's site list.
          if (event.item.kind === 'session') {
            void queryClient.invalidateQueries({ queryKey: ['computer-sites'] });
          }
          break;
        case 'vault.deleted':
          queryClient.setQueryData<VaultItem[]>(['vault'], (list) =>
            list?.filter((item) => item.id !== event.itemId),
          );
          break;
        case 'question.updated': {
          const { question } = event;
          queryClient.setQueryData<Question[]>(['questions'], (list) => {
            const others = list?.filter((q) => q.id !== question.id);
            return question.status === 'open' && others ? [question, ...others] : others;
          });
          break;
        }
        case 'routine.updated':
        case 'routine.deleted':
          void queryClient.invalidateQueries({ queryKey: ['routines'] });
          break;
        case 'automation.updated':
          queryClient.setQueryData<Automation[]>(['automations'], (list) =>
            upsert(list, event.automation),
          );
          break;
        case 'automation.deleted':
          queryClient.setQueryData<Automation[]>(['automations'], (list) =>
            list?.filter((a) => a.id !== event.automationId),
          );
          break;
        case 'system.updated':
          queryClient.setQueryData(['system'], event.settings);
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
