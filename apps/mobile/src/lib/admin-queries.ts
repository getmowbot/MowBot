import type {
  Automation,
  AutomationStatus,
  Device,
  Me,
  MeUpdate,
  Provider,
  ProviderCreate,
  ProviderUpdate,
  PushPrefs,
  Routine,
  RoutineCreate,
  RoutineUpdate,
  SystemSettings,
  SystemSettingsUpdate,
} from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import i18n from '../i18n';
import { isCanvasLive } from './automations';
import { problemCode } from './hub-url';
import { data, keys } from './queries';
import { api } from './session';

/** Models a provider advertises (doubles as its connection test). Not fed by events. */
const providerModelsKey = (providerId: string) => ['provider-models', providerId] as const;

/* ------------------------------------------------------------------ errors */

/** Hub problems worded in the app's language; the others fall back to a generic message. */
const WORDED = [
  'invalid_trigger',
  'too_many_routines',
  'heartbeat',
  'base_url_required',
  'not_found',
  'forbidden',
  'provider_unreachable',
  'provider_error',
] as const;

/** The message to show for a failed admin action. */
export function adminError(error: unknown, fallback: string): string {
  const code = problemCode(error);
  if (code === 'validation_failed' || code === 'rate_limited') return i18n.t(`errors.${code}`);
  if (code && (WORDED as readonly string[]).includes(code)) {
    return i18n.t(`appAdmin.problems.${code as (typeof WORDED)[number]}`);
  }
  return fallback;
}

/** The hub's own explanation (e.g. why a provider is unreachable), when it gave one. */
export function problemDetail(error: unknown): string | null {
  const detail = (error as { detail?: unknown } | null | undefined)?.detail;
  return typeof detail === 'string' && detail ? detail : null;
}

async function noContent(call: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await call;
  if (error !== undefined) throw error;
}

/* ------------------------------------------------------------------ account */

export function useUpdateMe() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: MeUpdate) => data(api().PATCH('/api/v1/me', { body })),
    onSuccess: (me) => client.setQueryData<Me>(keys.me, me),
  });
}

/** What this phone is told about (lib/push.ts turns its notifications on and off). */
export function useUpdatePushPrefs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (prefs: Partial<PushPrefs>) =>
      data(api().PUT('/api/v1/me/push', { body: { prefs } })),
    onSuccess: (me) => client.setQueryData<Me>(keys.me, me),
  });
}

/* ------------------------------------------------------------------ providers */

export function useProviderModels(providerId: string | null | undefined) {
  return useQuery({
    queryKey: providerModelsKey(providerId ?? ''),
    enabled: Boolean(providerId),
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/providers/{id}/models', {
            params: { path: { id: providerId as string } },
          }),
        )
      ).items.map((model) => model.id),
  });
}

export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderCreate) => data(api().POST('/api/v1/providers', { body })),
    onSuccess: (provider) => {
      client.setQueryData<Provider[]>(keys.providers, (list) => list && [...list, provider]);
      void client.invalidateQueries({ queryKey: keys.providers });
      // The first provider is given to the bots without one.
      void client.invalidateQueries({ queryKey: keys.bots });
    },
  });
}

export function useUpdateProvider(providerId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderUpdate) =>
      data(api().PATCH('/api/v1/providers/{id}', { params: { path: { id: providerId } }, body })),
    onSuccess: (provider) => {
      client.setQueryData<Provider[]>(keys.providers, (list) =>
        list?.map((p) => (p.id === provider.id ? provider : p)),
      );
      // A new key, URL or headers: test the connection again.
      void client.invalidateQueries({ queryKey: providerModelsKey(providerId) });
    },
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (providerId: string) =>
      noContent(api().DELETE('/api/v1/providers/{id}', { params: { path: { id: providerId } } })),
    onSuccess: (_, providerId) => {
      client.setQueryData<Provider[]>(keys.providers, (list) =>
        list?.filter((p) => p.id !== providerId),
      );
      client.removeQueries({ queryKey: providerModelsKey(providerId) });
      void client.invalidateQueries({ queryKey: keys.bots });
    },
  });
}

/* ------------------------------------------------------------------ routines */

export function useRoutines() {
  return useQuery({
    queryKey: keys.routines,
    queryFn: async () => (await data(api().GET('/api/v1/routines'))).items,
  });
}

export function useRoutine(routineId: string | undefined) {
  const routines = useRoutines();
  return { ...routines, data: routines.data?.find((routine) => routine.id === routineId) };
}

export function useRoutineRuns(routineId: string | undefined) {
  return useQuery({
    queryKey: keys.routineRuns(routineId ?? ''),
    enabled: Boolean(routineId),
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/routines/{id}/runs', {
            params: { path: { id: routineId as string } },
          }),
        )
      ).items,
  });
}

function upsertRoutine(list: Routine[] | undefined, routine: Routine): Routine[] | undefined {
  if (!list) return list;
  return list.some((r) => r.id === routine.id)
    ? list.map((r) => (r.id === routine.id ? routine : r))
    : [...list, routine];
}

export function useCreateRoutine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RoutineCreate) => data(api().POST('/api/v1/routines', { body })),
    onSuccess: (routine) =>
      client.setQueryData<Routine[]>(keys.routines, (list) => upsertRoutine(list, routine)),
  });
}

export function useUpdateRoutine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RoutineUpdate & { id: string }) =>
      data(api().PATCH('/api/v1/routines/{id}', { params: { path: { id } }, body })),
    onSuccess: (routine) =>
      client.setQueryData<Routine[]>(keys.routines, (list) => upsertRoutine(list, routine)),
  });
}

export function useDeleteRoutine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (routineId: string) =>
      noContent(api().DELETE('/api/v1/routines/{id}', { params: { path: { id: routineId } } })),
    onSuccess: (_, routineId) => {
      client.setQueryData<Routine[]>(keys.routines, (list) =>
        list?.filter((r) => r.id !== routineId),
      );
      client.removeQueries({ queryKey: keys.routineRuns(routineId) });
    },
  });
}

/** Fires a routine now, even when paused, over budget or in quiet hours. */
export function useRunRoutine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (routineId: string) =>
      data(api().POST('/api/v1/routines/{id}/run', { params: { path: { id: routineId } } })),
    onSettled: (_, __, routineId) => {
      void client.invalidateQueries({ queryKey: keys.routineRuns(routineId) });
      void client.invalidateQueries({ queryKey: keys.routines });
    },
  });
}

/* ------------------------------------------------------------------ automations */

const fetchAutomations = async () => (await data(api().GET('/api/v1/automations'))).items;

/** Bots' scripts the hub runs on their PCs, kept live by events (finished ones stay a day). */
export function useAutomations() {
  return useQuery({ queryKey: keys.automations, queryFn: fetchAutomations });
}

/**
 * Whether an active automation keeps this home card up to date: the same query as the list,
 * the card only re-renders when its own answer changes.
 */
export function useCanvasLive(canvasId: string): boolean {
  const select = useCallback((items: Automation[]) => isCanvasLive(items, canvasId), [canvasId]);
  const live = useQuery({ queryKey: keys.automations, queryFn: fetchAutomations, select });
  return live.data ?? false;
}

function upsertAutomation(
  list: Automation[] | undefined,
  automation: Automation,
): Automation[] | undefined {
  if (!list) return list;
  return list.some((a) => a.id === automation.id)
    ? list.map((a) => (a.id === automation.id ? automation : a))
    : [...list, automation];
}

/** Pauses or resumes an automation (resuming clears its failures). */
export function useUpdateAutomation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: Exclude<AutomationStatus, 'stopped'> }) =>
      data(api().PATCH('/api/v1/automations/{id}', { params: { path: { id } }, body: { status } })),
    onSuccess: (automation) =>
      client.setQueryData<Automation[]>(keys.automations, (list) =>
        upsertAutomation(list, automation),
      ),
  });
}

/** Stops and deletes an automation. */
export function useDeleteAutomation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (automationId: string) =>
      noContent(
        api().DELETE('/api/v1/automations/{id}', { params: { path: { id: automationId } } }),
      ),
    onSuccess: (_, automationId) =>
      client.setQueryData<Automation[]>(keys.automations, (list) =>
        list?.filter((a) => a.id !== automationId),
      ),
  });
}

/* ------------------------------------------------------------------ proactivity */

export function useSystem() {
  return useQuery({
    queryKey: keys.system,
    queryFn: () => data(api().GET('/api/v1/system')),
  });
}

export function useUpdateSystem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SystemSettingsUpdate) => data(api().PATCH('/api/v1/system', { body })),
    onSuccess: (settings) => client.setQueryData<SystemSettings>(keys.system, settings),
  });
}

/* ------------------------------------------------------------------ devices */

export function useDevices() {
  return useQuery({
    queryKey: keys.devices,
    queryFn: async () => (await data(api().GET('/api/v1/devices'))).items,
  });
}

export function useRevokeDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: string) =>
      noContent(api().DELETE('/api/v1/devices/{id}', { params: { path: { id: deviceId } } })),
    onSuccess: (_, deviceId) => {
      const now = new Date().toISOString();
      client.setQueryData<Device[]>(keys.devices, (list) =>
        list?.map((d) => (d.id === deviceId ? { ...d, revokedAt: d.revokedAt ?? now } : d)),
      );
      void client.invalidateQueries({ queryKey: keys.devices });
    },
  });
}
