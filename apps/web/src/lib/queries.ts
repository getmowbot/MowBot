import type { Computer, Message, Provider, TaskStatus } from '@mowbot/contract';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './auth';
import type { Listing } from './models';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/me');
      if (error || !data) throw error;
      return data;
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ['teams'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/teams');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

export function useTeam(teamId: string | undefined) {
  const teams = useTeams();
  return { ...teams, data: teams.data?.find((team) => team.id === teamId) };
}

/** A team's plan of attack (null: none yet), kept current by `plan.updated` events. */
export function usePlan(teamId: string) {
  return useQuery({
    queryKey: ['plan', teamId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/teams/{id}/plan', {
        params: { path: { id: teamId } },
      });
      if (error || !data) throw error;
      return data.plan;
    },
  });
}

export function useComputers() {
  return useQuery({
    queryKey: ['computers'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/computers');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

const TRANSITIONS = new Set(['starting', 'stopping']);

export function useComputer(computerId: string | null | undefined) {
  return useQuery({
    queryKey: ['computer', computerId],
    enabled: Boolean(computerId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/computers/{id}', {
        params: { path: { id: computerId as string } },
      });
      if (error || !data) throw error;
      return data;
    },
    // Events push updates; polling during transitions covers a dropped event stream.
    refetchInterval: (query) => (TRANSITIONS.has(query.state.data?.status ?? '') ? 3_000 : false),
  });
}

export type ComputerAction = 'start' | 'stop' | 'restart' | 'takeover' | 'release';

export function useComputerAction(computerId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: ComputerAction): Promise<Computer> => {
      const params = { params: { path: { id: computerId as string } } };
      const call = {
        start: () => api.POST('/api/v1/computers/{id}/start', params),
        stop: () => api.POST('/api/v1/computers/{id}/stop', params),
        restart: () => api.POST('/api/v1/computers/{id}/restart', params),
        takeover: () => api.POST('/api/v1/computers/{id}/takeover', params),
        release: () => api.DELETE('/api/v1/computers/{id}/takeover', params),
      }[action];
      const { data, error } = await call();
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (computer) => {
      queryClient.setQueryData(['computer', computer.id], computer);
      void queryClient.invalidateQueries({ queryKey: ['computers'] });
    },
  });
}

export function useBots() {
  return useQuery({
    queryKey: ['bots'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/bots');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** The bot's own Chrome window, re-captured while shown. */
export function useBotBrowser(botId: string) {
  return useQuery({
    queryKey: ['bot-browser', botId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/bots/{id}/browser', {
        params: { path: { id: botId } },
      });
      if (error || !data) throw error;
      return data;
    },
    refetchInterval: 1_500,
    gcTime: 0,
  });
}

export function useShowBotBrowser(botId: string) {
  return useMutation({
    mutationFn: async () => {
      const { error } = await api.POST('/api/v1/bots/{id}/browser/front', {
        params: { path: { id: botId } },
      });
      if (error) throw error;
    },
  });
}

export function useBot(botId: string | undefined) {
  const bots = useBots();
  return { ...bots, data: bots.data?.find((bot) => bot.id === botId) };
}

export function useChef() {
  const bots = useBots();
  return { ...bots, data: bots.data?.find((bot) => bot.isChef) };
}

/** Messages loaded at once: the end of a conversation, then more as the user scrolls up. */
export const MESSAGES_PAGE = 40;

/**
 * The end of a conversation, and the earlier pages the user scrolled up to (kept when it
 * reloads). Where the next earlier page starts is under `['messages-before', botId]`.
 */
export function useMessages(botId: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['messages', botId],
    enabled: Boolean(botId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/bots/{id}/messages', {
        params: { path: { id: botId as string }, query: { limit: MESSAGES_PAGE } },
      });
      if (error || !data) throw error;
      const first = data.items[0];
      const earlier = first
        ? (queryClient.getQueryData<Message[]>(['messages', botId]) ?? []).filter(
            (m) => m.createdAt < first.createdAt,
          )
        : [];
      if (earlier.length === 0)
        queryClient.setQueryData(['messages-before', botId], data.nextCursor);
      return [...earlier, ...data.items];
    },
  });
}

/** The page of messages before those loaded: `load` puts it first; `more` is false at the start. */
export function useEarlierMessages(botId: string | undefined) {
  const queryClient = useQueryClient();
  const cursor = useQuery({
    queryKey: ['messages-before', botId],
    queryFn: () => null as string | null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const load = useMutation({
    mutationFn: async () => {
      const before = queryClient.getQueryData<string | null>(['messages-before', botId]);
      if (!botId || !before) return;
      const { data, error } = await api.GET('/api/v1/bots/{id}/messages', {
        params: { path: { id: botId }, query: { limit: MESSAGES_PAGE, before } },
      });
      if (error || !data) throw error;
      queryClient.setQueryData<Message[]>(['messages', botId], (list = []) => {
        const known = new Set(list.map((m) => m.id));
        return [...data.items.filter((m) => !known.has(m.id)), ...list];
      });
      queryClient.setQueryData(['messages-before', botId], data.nextCursor);
    },
  });
  return { more: Boolean(cursor.data), loading: load.isPending, load: load.mutateAsync };
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/providers');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** What each provider lists, fetched while `enabled` (the same cache as the Models page). */
export function useListings(
  providers: readonly Pick<Provider, 'id'>[],
  enabled: boolean,
): Map<string, Listing> {
  const results = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ['models', provider.id],
      enabled,
      retry: false,
      staleTime: 5 * 60_000,
      queryFn: async () => {
        const { data, error } = await api.GET('/api/v1/providers/{id}/models', {
          params: { path: { id: provider.id } },
        });
        if (error || !data) throw error;
        return data.items;
      },
    })),
  });
  return new Map(
    providers.map((provider, index): [string, Listing] => {
      const result = results[index];
      if (result?.isSuccess) return [provider.id, { state: 'ready', items: result.data }];
      if (result?.isError) return [provider.id, { state: 'unreachable' }];
      return [provider.id, { state: 'loading' }];
    }),
  );
}

export function useTasks(filter: { botId?: string; status?: TaskStatus } = {}) {
  return useQuery({
    queryKey: ['tasks', filter],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/tasks', { params: { query: filter } });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** Latest messages between bots (oldest → newest). */
export function useFeed(limit = 100) {
  return useQuery({
    queryKey: ['feed', limit],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/feed', { params: { query: { limit } } });
      if (error || !data) throw error;
      return data.items;
    },
  });
}
