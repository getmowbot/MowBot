import type {
  Automation,
  AutomationOutcome,
  AutomationStop,
  Notification,
  Question,
  SystemSettingsUpdate,
} from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { i18n } from '../i18n';
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

/**
 * The user is in a bot's conversation: what that bot notified them of is seen (now, and as
 * new notifications of it come while the conversation is open and in view).
 */
export function useSeenInConversation(botId: string | undefined) {
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const unread = (notifications.data?.items ?? []).filter((n) => n.botId === botId && !n.readAt);
  const pending = unread.map((n) => n.id).join(',');
  useEffect(() => {
    if (!botId || !pending) return;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      void api
        .POST('/api/v1/notifications/read', { body: { botId } })
        .finally(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }));
    };
    mark();
    // In a background tab: once the user comes back to it.
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [botId, pending, queryClient]);
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

/** Bots' scripts the hub runs on their PCs: active, paused, and those stopped in the last day. */
export function useAutomations<T = Automation[]>(select?: (items: Automation[]) => T) {
  return useQuery({
    queryKey: ['automations'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/automations');
      if (error || !data) throw error;
      return data.items;
    },
    select,
  });
}

/** The active automation keeping this canvas up to date, if any (one fetch for every card). */
export function useLiveAutomation(canvasId: string): Automation | null {
  const live = useAutomations((items) =>
    items.find((a) => a.status === 'active' && a.canvasId === canvasId),
  );
  return live.data ?? null;
}

/** Pauses or resumes an automation; the hub's event confirms it on every device. */
export function useUpdateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'active' | 'paused' }) => {
      const { data, error } = await api.PATCH('/api/v1/automations/{id}', {
        params: { path: { id } },
        body: { status },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (automation) =>
      queryClient.setQueryData<Automation[]>(['automations'], (list) =>
        list?.map((a) => (a.id === automation.id ? automation : a)),
      ),
  });
}

export function useDeleteAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/automations/{id}', {
        params: { path: { id } },
      });
      if (error) throw error;
    },
    onSuccess: (_, id) =>
      queryClient.setQueryData<Automation[]>(['automations'], (list) =>
        list?.filter((a) => a.id !== id),
      ),
  });
}

/** An automation's pace: "toutes les 30 s", "toutes les 5 min"… */
export function automationEvery(seconds: number): string {
  if (seconds % 3600 === 0) return i18n.t('automations.every.hours', { count: seconds / 3600 });
  if (seconds % 60 === 0) return i18n.t('automations.every.minutes', { count: seconds / 60 });
  return i18n.t('automations.every.seconds', { count: seconds });
}

type AutomationError = NonNullable<AutomationOutcome['error']>;

/** Failures whose detail is the script's own words (or what is wrong with its output). */
const SCRIPT_ERRORS: ReadonlySet<AutomationError['kind']> = new Set(['exit', 'output', 'other']);

function automationErrorLabel({ kind, code, detail }: AutomationError): string {
  switch (kind) {
    case 'exit':
      return code === null
        ? i18n.t('automations.errors.exit')
        : i18n.t('automations.errors.exitCode', { code });
    case 'timeout':
      return i18n.t('automations.errors.timeout', { limit: detail });
    default:
      return i18n.t(`automations.errors.${kind}`);
  }
}

/** What the last run did: "Carte mise à jour · Bot réveillé", or why it failed. */
export function automationOutcomeLabel(outcome: AutomationOutcome): string {
  if (outcome.error) return automationErrorLabel(outcome.error);
  if (outcome.actions.length === 0) return i18n.t('automations.actions.none');
  return outcome.actions.map((action) => i18n.t(`automations.actions.${action}`)).join(' · ');
}

/** The script's own words about a failed run (stderr, invalid output…), when it has some. */
export function automationErrorDetail(outcome: AutomationOutcome): string | null {
  const { error } = outcome;
  return error && SCRIPT_ERRORS.has(error.kind) && error.detail ? error.detail : null;
}

/** Why it ended or paused on its own, after its status: the script's words, "après 3 échecs"… */
export function automationStopLabel(stop: AutomationStop): string | null {
  switch (stop.reason) {
    case 'done':
      return stop.detail;
    case 'deadline':
      return i18n.t('automations.stop.deadline');
    case 'failures':
      return i18n.t('automations.stop.failures', { count: Number(stop.detail) });
  }
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

/** Sets a question aside without answering it (the bot is not told). */
export function useDismissQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await api.POST('/api/v1/questions/{id}/dismiss', {
        params: { path: { id } },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: (id) =>
      queryClient.setQueryData<Question[]>(['questions'], (list) =>
        list?.filter((q) => q.id !== id),
      ),
    // Answered meanwhile on another device: refresh.
    onError: () => queryClient.invalidateQueries({ queryKey: ['questions'] }),
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
