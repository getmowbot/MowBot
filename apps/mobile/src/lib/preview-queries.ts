import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { data, keys } from './queries';
import { api } from './session';

/** The web pages bots shared from a PC, with links for the hub address this phone uses. */
export function usePreviews(computerId: string, enabled = true) {
  return useQuery({
    queryKey: keys.previews(computerId),
    enabled: enabled && Boolean(computerId),
    queryFn: async () =>
      (await data(api().GET('/api/v1/previews', { params: { query: { computerId } } }))).items,
  });
}

export function useStopPreview(computerId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api().DELETE('/api/v1/previews/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: keys.previews(computerId) }),
  });
}
