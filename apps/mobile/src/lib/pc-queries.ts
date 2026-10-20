import type { Computer } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { problemCode } from './hub-url';
import { data, keys } from './queries';
import { api } from './session';

const TRANSITIONS = new Set<Computer['status']>(['starting', 'stopping']);

/**
 * One computer, from the list the event stream keeps up to date (`computer.updated`). While it
 * starts or stops, it is also polled in case an event is missed.
 */
export function useComputer(computerId: string | undefined) {
  return useQuery({
    queryKey: keys.computers,
    queryFn: async () => (await data(api().GET('/api/v1/computers'))).items,
    enabled: Boolean(computerId),
    select: (list) => list.find((computer) => computer.id === computerId),
    refetchInterval: (query) => {
      const computer = query.state.data?.find((c) => c.id === computerId);
      return computer && TRANSITIONS.has(computer.status) ? 3_000 : false;
    },
  });
}

export type ComputerAction = 'start' | 'stop' | 'restart' | 'takeover' | 'release';

/** Turn on, restart, turn off, take control (bots paused) or give it back. */
export function useComputerAction(computerId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ComputerAction): Promise<Computer> => {
      const params = { params: { path: { id: computerId } } };
      switch (action) {
        case 'start':
          return data(api().POST('/api/v1/computers/{id}/start', params));
        case 'stop':
          return data(api().POST('/api/v1/computers/{id}/stop', params));
        case 'restart':
          return data(api().POST('/api/v1/computers/{id}/restart', params));
        case 'takeover':
          return data(api().POST('/api/v1/computers/{id}/takeover', params));
        case 'release':
          return data(api().DELETE('/api/v1/computers/{id}/takeover', params));
      }
    },
    onSuccess: (computer) =>
      client.setQueryData<Computer[]>(keys.computers, (list) =>
        list?.map((c) => (c.id === computer.id ? computer : c)),
      ),
  });
}

/** A one-time ticket to open the desktop WebSocket (each connection needs a new one). */
export async function desktopTicket(computerId: string): Promise<string> {
  const { ticket } = await data(
    api().POST('/api/v1/computers/{id}/desktop-ticket', { params: { path: { id: computerId } } }),
  );
  return ticket;
}

/**
 * False while the app is in the background (nothing to show, no reason to poll). iOS's brief
 * `inactive` state (control center, app switcher) still counts as active.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setActive(state !== 'background'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

/** What a bot's own Chrome window shows, re-captured every 1.5 s while `live`. */
export function useBotBrowser(botId: string, live: boolean) {
  return useQuery({
    queryKey: keys.botBrowser(botId),
    queryFn: () =>
      data(api().GET('/api/v1/bots/{id}/browser', { params: { path: { id: botId } } })),
    enabled: live,
    refetchInterval: live ? 1_500 : false,
    // Captures are big and stale fast: never kept once the view is gone.
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}

/** Puts a bot's Chrome window in front on its PC's screen. */
export function useShowBotBrowser() {
  return useMutation({
    mutationFn: async (botId: string) => {
      const { error } = await api().POST('/api/v1/bots/{id}/browser/front', {
        params: { path: { id: botId } },
      });
      if (error) throw error;
    },
  });
}

/** Hub problems this screen words itself; anything else is "the action failed". */
export type PcProblem = 'computer_not_running' | 'no_page' | 'generic';

export function pcProblem(error: unknown): PcProblem {
  const code = problemCode(error);
  return code === 'computer_not_running' || code === 'no_page' ? code : 'generic';
}
