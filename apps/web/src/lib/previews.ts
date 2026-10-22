import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './auth';

/** The web pages bots shared from a PC (refetched on `previews.changed`). */
export function usePreviews(computerId: string | undefined) {
  return useQuery({
    queryKey: ['previews', computerId],
    enabled: Boolean(computerId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/previews', {
        params: { query: { computerId } },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

export function useStopPreview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/previews/{id}', {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['previews'] }),
  });
}

/** "18:42", or "Thu 18:42" when it is not today. */
export function untilLabel(iso: string, locale: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(locale, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}
