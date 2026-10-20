import type { Computer } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './auth';

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
