import type {
  Automation,
  Bot,
  Canvas,
  Computer,
  Connector,
  McpServer,
  Message,
  Project,
  Question,
  ServerEvent,
  SystemSettings,
  Task,
  Team,
  VaultItem,
} from '@mowbot/contract';
import type { QueryClient } from '@tanstack/react-query';
import type { NotificationList } from './board';
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
        'automations',
        'system',
        'providers',
        'devices',
        'vault',
        'vault-events',
        'mcp-servers',
        'mcp-calls',
        'projects',
        'connectors',
        'previews',
      ]) {
        void client.invalidateQueries({ queryKey: [key] });
      }
      break;
    case 'previews.changed':
      void client.invalidateQueries({ queryKey: keys.previews(event.computerId) });
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
    case 'notifications.cleared':
      client.setQueryData<NotificationList>(keys.notifications, (current) =>
        current ? { items: [], unread: 0 } : current,
      );
      break;
    case 'activity.cleared':
      // Finished tasks are gone at once; the feed starts over.
      client.setQueryData<Task[]>(keys.tasks, (list) =>
        list?.filter((task) => task.status !== 'done' && task.status !== 'cancelled'),
      );
      void client.invalidateQueries({ queryKey: keys.tasks });
      void client.invalidateQueries({ queryKey: keys.feed });
      break;
    case 'vault.updated':
      client.setQueryData<VaultItem[]>(keys.vault, (list) => upsert(list, event.item));
      // Saved, used, granted…: one more line in its history.
      void client.invalidateQueries({ queryKey: keys.vaultEvents(event.item.id) });
      break;
    case 'vault.deleted':
      client.setQueryData<VaultItem[]>(keys.vault, (list) =>
        list?.filter((item) => item.id !== event.itemId),
      );
      client.removeQueries({ queryKey: keys.vaultEvents(event.itemId) });
      break;
    case 'mcp.updated':
      client.setQueryData<McpServer[]>(keys.mcpServers, (list) => upsert(list, event.server));
      // Its status changes as bots call it (a failure, a sign-in to renew): new lines likely.
      void client.invalidateQueries({ queryKey: keys.mcpCalls(event.server.id) });
      break;
    case 'mcp.deleted':
      client.setQueryData<McpServer[]>(keys.mcpServers, (list) =>
        list?.filter((server) => server.id !== event.serverId),
      );
      client.removeQueries({ queryKey: keys.mcpCalls(event.serverId) });
      break;
    case 'project.updated':
      client.setQueryData<Project[]>(keys.projects, (list) => upsert(list, event.project));
      break;
    case 'project.deleted':
      client.setQueryData<Project[]>(keys.projects, (list) =>
        list?.filter((project) => project.id !== event.projectId),
      );
      break;
    case 'connector.updated':
      // Online or not, last seen: its projects follow with their own `project.updated`.
      client.setQueryData<Connector[]>(keys.connectors, (list) => upsert(list, event.connector));
      break;
    case 'connector.deleted':
      client.setQueryData<Connector[]>(keys.connectors, (list) =>
        list?.filter((connector) => connector.id !== event.connectorId),
      );
      // Its projects go with it (each one is also sent as `project.deleted`).
      client.setQueryData<Project[]>(keys.projects, (list) =>
        list?.filter((project) => project.connectorId !== event.connectorId),
      );
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
    case 'automation.updated':
      // Each run (its result, its failures), a pause, the end: the list and the Live badges.
      client.setQueryData<Automation[]>(keys.automations, (list) => upsert(list, event.automation));
      break;
    case 'automation.deleted':
      client.setQueryData<Automation[]>(keys.automations, (list) =>
        list?.filter((a) => a.id !== event.automationId),
      );
      break;
    case 'system.updated':
      client.setQueryData<SystemSettings>(keys.system, event.settings);
      break;
    case 'bot.updated': {
      const before = client.getQueryData<Bot[]>(keys.bots)?.find((b) => b.id === event.bot.id);
      client.setQueryData<Bot[]>(keys.bots, (list) => upsert(list, event.bot));
      // A new bot may come with a new PC (what it is doing changes often: not for that).
      if (before?.computerId !== event.bot.computerId) {
        void client.invalidateQueries({ queryKey: keys.computers });
      }
      break;
    }
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
