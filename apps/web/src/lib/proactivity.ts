import type { Notification, Question, SystemSettingsUpdate } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './auth';

export function useCanvases() {
  return useQuery({
    queryKey: ['canvases'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/canvases');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/notifications');
      if (error || !data) throw error;
      return data;
    },
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      await api.POST('/api/v1/notifications/read', { body: ids ? { ids } : {} });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/** Deletes every notification. */
export function useClearNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/notifications');
      if (error) throw error;
    },
    onSuccess: () => queryClient.setQueryData(['notifications'], { items: [], unread: 0 }),
  });
}

export function useSystem() {
  return useQuery({
    queryKey: ['system'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/system');
      if (error || !data) throw error;
      return data;
    },
  });
}

export function useUpdateSystem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SystemSettingsUpdate) => {
      const { data, error } = await api.PATCH('/api/v1/system', { body });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (settings) => queryClient.setQueryData(['system'], settings),
  });
}

export function useRoutines(botId?: string) {
  return useQuery({
    queryKey: ['routines', botId ?? 'all'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/routines', {
        params: { query: botId ? { botId } : {} },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

export function useRoutineRuns(routineId: string | null) {
  return useQuery({
    queryKey: ['routines', 'runs', routineId],
    enabled: Boolean(routineId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/routines/{id}/runs', {
        params: { path: { id: routineId as string } },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** Whether this browser may show system notifications (asked once, by the user's click). */
export function alertsPermission(): NotificationPermission | 'unsupported' {
  return typeof window !== 'undefined' && 'Notification' in window
    ? window.Notification.permission
    : 'unsupported';
}

/**
 * Urgent and normal notifications also pop up on this device when the app is in the
 * background (and the user allowed it). Digest-level ones wait for the evening summary.
 */
export function alertOnThisDevice(notification: Notification): void {
  if (notification.priority === 'digest') return;
  if (alertsPermission() !== 'granted' || document.visibilityState === 'visible') return;
  try {
    new window.Notification(notification.title, {
      body: notification.body ?? undefined,
      tag: notification.id,
      icon: '/favicon.svg',
    });
  } catch {
    // Some browsers only allow notifications from a service worker.
  }
}

/** Questions bots asked the user that still wait for an answer, newest first. */
export function useQuestions() {
  return useQuery({
    queryKey: ['questions'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/questions');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

export function useAnswerQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, answer }: { id: string; answer: string }) => {
      const { data, error } = await api.POST('/api/v1/questions/{id}/answer', {
        params: { path: { id } },
        body: { answer },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (question) =>
      queryClient.setQueryData<Question[]>(['questions'], (list) =>
        list?.filter((q) => q.id !== question.id),
      ),
    // Answered meanwhile on another device: refresh.
    onError: () => queryClient.invalidateQueries({ queryKey: ['questions'] }),
  });
}
