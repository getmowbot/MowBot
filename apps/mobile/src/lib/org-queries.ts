import type {
  Bot,
  BotCreate,
  BotMove,
  BotUpdate,
  Task,
  TaskCreate,
  Team,
  TeamCreate,
  TeamUpdate,
} from '@mowbot/contract';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { data, keys, useTeams } from './queries';
import { api } from './session';

/** Replaces the item with the same id, or appends it. */
function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

const putBot = (client: QueryClient, bot: Bot) =>
  client.setQueryData<Bot[]>(keys.bots, (list) => upsert(list, bot));
const putTeam = (client: QueryClient, team: Team) =>
  client.setQueryData<Team[]>(keys.teams, (list) => upsert(list, team));

async function ok(call: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await call;
  if (error !== undefined) throw error;
}

export function useTeam(teamId: string | undefined) {
  const teams = useTeams();
  return { ...teams, data: teams.data?.find((team) => team.id === teamId) };
}

export function useCreateTeam() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TeamCreate) => data(api().POST('/api/v1/teams', { body })),
    onSuccess: (team) => {
      putTeam(client, team);
      // It comes with a PC.
      void client.invalidateQueries({ queryKey: keys.computers });
    },
  });
}

export function useUpdateTeam() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TeamUpdate }) =>
      data(api().PATCH('/api/v1/teams/{id}', { params: { path: { id } }, body })),
    onSuccess: (team) => putTeam(client, team),
  });
}

export function useDeleteTeam() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      ok(api().DELETE('/api/v1/teams/{id}', { params: { path: { id } } })),
    onSuccess: (_, id) => {
      client.setQueryData<Team[]>(keys.teams, (list) => list?.filter((team) => team.id !== id));
      void client.invalidateQueries({ queryKey: keys.computers });
    },
  });
}

export function useCreateBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BotCreate) => data(api().POST('/api/v1/bots', { body })),
    onSuccess: (bot) => {
      putBot(client, bot);
      void client.invalidateQueries({ queryKey: keys.computers });
      // Made lead of its team.
      void client.invalidateQueries({ queryKey: keys.teams });
    },
  });
}

/** Saves a bot's settings, then its team's lead if that changed. */
export function useSaveBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      bot,
      changes,
      lead,
    }: {
      bot: Bot;
      changes: BotUpdate;
      /** The team's new lead (a bot id or nobody); undefined: unchanged. */
      lead?: { teamId: string; leadBotId: string | null };
    }) => {
      if (Object.keys(changes).length > 0) {
        putBot(
          client,
          await data(
            api().PATCH('/api/v1/bots/{id}', { params: { path: { id: bot.id } }, body: changes }),
          ),
        );
      }
      if (lead) {
        putTeam(
          client,
          await data(
            api().PATCH('/api/v1/teams/{id}', {
              params: { path: { id: lead.teamId } },
              body: { leadBotId: lead.leadBotId },
            }),
          ),
        );
      }
    },
    onSuccess: (_, { changes }) => {
      // The check-in routine follows the rhythm.
      if (changes.heartbeatMinutes !== undefined) {
        void client.invalidateQueries({ queryKey: keys.routines });
      }
    },
  });
}

export function useDeleteBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ok(api().DELETE('/api/v1/bots/{id}', { params: { path: { id } } })),
    onSuccess: (_, id) => {
      client.setQueryData<Bot[]>(keys.bots, (list) => list?.filter((bot) => bot.id !== id));
      // Its dedicated PC goes; its team may lose its lead.
      void client.invalidateQueries({ queryKey: keys.computers });
      void client.invalidateQueries({ queryKey: keys.teams });
    },
  });
}

export function useMoveBot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BotMove }) =>
      data(api().POST('/api/v1/bots/{id}/move', { params: { path: { id } }, body })),
    onSuccess: (bot) => {
      putBot(client, bot);
      void client.invalidateQueries({ queryKey: keys.computers });
      // Its former team may have lost its lead.
      void client.invalidateQueries({ queryKey: keys.teams });
    },
  });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskCreate) => data(api().POST('/api/v1/tasks', { body })),
    onSuccess: (task) => {
      client.setQueryData<Task[]>(keys.tasks, (list) => (list ? [task, ...list] : list));
      void client.invalidateQueries({ queryKey: keys.tasks });
    },
  });
}
