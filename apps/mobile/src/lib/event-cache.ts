import type {
  Bot,
  Canvas,
  Computer,
  Message,
  Question,
  ServerEvent,
  SystemSettings,
  Team,
} from '@mowbot/contract';
import type { QueryClient } from '@tanstack/react-query';
import { appendDelta, type Conversation, upsertMessage } from './message-cache';
import { keys } from './query-keys';

/** Replaces the item with the same id, or appends it (created elsewhere: another device, a bot). */
function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

function onMessage(client: QueryClient, message: Message) {
  client.setQueryData<Conversation>(keys.messages(message.botId), (current) =>
    current ? upsertMessage(current, message) : current,
  );
  if (message.role === 'assistant') {
    client.setQueryData(keys.live(message.botId), message.status === 'streaming' ? message : null);
  }
  if (message.fromBotId) void client.invalidateQueries({ queryKey: keys.feed });
}

/** Applies one hub event to the React Query cache (mirrors the web app). */
export function applyServerEvent(client: QueryClient, event: ServerEvent) {
  switch (event.type) {
    case 'ready':
      // (Re)connected: whatever happened while offline is unknown, refetch.
      client.removeQueries({ queryKey: ['live'] });
      for (const key of [
        'bots',
        'teams',
        'computers',
        'messages',
        'tasks',
        'feed',
        'me',
        'canvases',
        'notifications',
        'questions',
        'routines',
        'system',
        'providers',
        'devices',
      ]) {
        void client.invalidateQueries({ queryKey: [key] });
      }
      break;
    case 'computer.updated':
      client.setQueryData<Computer[]>(keys.computers, (list) => upsert(list, event.computer));
      break;
    case 'workspace.changed':
      // Folder listings of that workspace (any path) refetch if shown.
      void client.invalidateQueries({ queryKey: ['files', event.workspaceId] });
      break;
    case 'canvas.updated':
      client.setQueryData<Canvas[]>(keys.canvases, (list) =>
        upsert(list, event.canvas)?.sort((a, b) => a.position - b.position),
      );
      break;
    case 'canvas.deleted':
      client.setQueryData<Canvas[]>(keys.canvases, (list) =>
        list?.filter((c) => c.id !== event.canvasId),
      );
      break;
    case 'notification.created':
      void client.invalidateQueries({ queryKey: keys.notifications });
      break;
    case 'question.updated': {
      const { question } = event;
      client.setQueryData<Question[]>(keys.questions, (list) => {
        const others = list?.filter((q) => q.id !== question.id);
        return question.status === 'open' && others ? [question, ...others] : others;
      });
      break;
    }
    case 'routine.updated':
    case 'routine.deleted':
      void client.invalidateQueries({ queryKey: keys.routines });
      break;
    case 'system.updated':
      client.setQueryData<SystemSettings>(keys.system, event.settings);
      break;
    case 'bot.updated':
      client.setQueryData<Bot[]>(keys.bots, (list) => upsert(list, event.bot));
      // A new bot may come with a new PC.
      void client.invalidateQueries({ queryKey: keys.computers });
      break;
    case 'bot.deleted':
      client.setQueryData<Bot[]>(keys.bots, (list) => list?.filter((b) => b.id !== event.botId));
      break;
    case 'team.updated':
      client.setQueryData<Team[]>(keys.teams, (list) => upsert(list, event.team));
      void client.invalidateQueries({ queryKey: keys.computers });
      break;
    case 'team.deleted':
      client.setQueryData<Team[]>(keys.teams, (list) => list?.filter((t) => t.id !== event.teamId));
      break;
    case 'task.updated':
      void client.invalidateQueries({ queryKey: keys.tasks });
      break;
    case 'message.deleted':
      client.setQueryData<Conversation>(keys.messages(event.botId), (current) =>
        current
          ? { ...current, items: current.items.filter((m) => m.id !== event.messageId) }
          : current,
      );
      break;
    case 'messages.cleared':
      client.setQueryData<Conversation>(keys.messages(event.botId), (current) =>
        current ? { items: [], nextCursor: null } : current,
      );
      break;
    case 'message.updated':
      onMessage(client, event.message);
      break;
    case 'message.delta':
      client.setQueryData<Conversation>(keys.messages(event.botId), (current) =>
        current ? appendDelta(current, event) : current,
      );
      break;
  }
}
