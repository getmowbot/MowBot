import type { Canvas, CanvasSize, Question, SystemSettingsUpdate } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { applyOrder, editChecklist, markRead, type NotificationList, replaceCanvas } from './board';
import { data, keys } from './queries';
import { api } from './session';

/** Calls answering 204 (no body): fails on a problem or a non-2xx status. */
async function done(call: Promise<{ error?: unknown; response: Response }>): Promise<void> {
  const { error, response } = await call;
  if (error !== undefined || !response.ok) throw error ?? new Error(`HTTP ${response.status}`);
}

// ---------------------------------------------------------------------------------------------
// Canvases

/** The home page cards in the user's order, hidden ones included (flagged). */
export function useCanvases() {
  return useQuery({
    queryKey: keys.canvases,
    queryFn: async () => (await data(api().GET('/api/v1/canvases'))).items,
  });
}

/**
 * Layout changes of the cards: applied to the cache at once, confirmed by the hub (and its
 * events); refetched when the hub disagrees.
 */
export function useCanvasActions() {
  const client = useQueryClient();
  const set = (change: (list: Canvas[]) => Canvas[]) =>
    client.setQueryData<Canvas[]>(keys.canvases, (list) => (list ? change(list) : list));
  const resync = () => client.invalidateQueries({ queryKey: keys.canvases });

  const update = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { size?: CanvasSize; hidden?: boolean; collapsed?: boolean };
    }) => data(api().PATCH('/api/v1/canvases/{id}', { params: { path: { id } }, body })),
    onMutate: ({ id, body }) =>
      set((list) => list.map((c) => (c.id === id ? { ...c, ...body } : c))),
    onSuccess: (canvas) => set((list) => replaceCanvas(list, canvas) ?? list),
    onError: () => void resync(),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      done(api().DELETE('/api/v1/canvases/{id}', { params: { path: { id } } })),
    onMutate: (id) => set((list) => list.filter((c) => c.id !== id)),
    onError: () => void resync(),
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => done(api().PUT('/api/v1/canvases/order', { body: { ids } })),
    onMutate: (ids) => set((list) => applyOrder(list, ids)),
    onError: () => void resync(),
  });

  /** A card's button that answers the bot that pinned it (as the user's message). */
  const press = useMutation({
    mutationFn: ({ id, button }: { id: string; button: number }) =>
      done(
        api().POST('/api/v1/canvases/{id}/press', { params: { path: { id } }, body: { button } }),
      ),
    // The card may have changed meanwhile (the bot updated it): show it as it is now.
    onError: () => void resync(),
  });

  return { update, remove, reorder, press };
}

/** Ticks, additions and removals on a checklist card (ticks and removals show at once). */
export function useChecklist(canvasId: string) {
  const client = useQueryClient();
  const edit = (change: Parameters<typeof editChecklist>[1]) =>
    client.setQueryData<Canvas[]>(keys.canvases, (list) =>
      list?.map((c) => (c.id === canvasId ? editChecklist(c, change) : c)),
    );
  const confirm = (canvas: Canvas) =>
    client.setQueryData<Canvas[]>(keys.canvases, (list) => replaceCanvas(list, canvas));
  const resync = () => client.invalidateQueries({ queryKey: keys.canvases });

  const toggle = useMutation({
    mutationFn: ({ itemId, done: checked }: { itemId: string; done: boolean }) =>
      data(
        api().PATCH('/api/v1/canvases/{id}/items/{itemId}', {
          params: { path: { id: canvasId, itemId } },
          body: { done: checked },
        }),
      ),
    onMutate: ({ itemId, done: checked }) =>
      edit((items) => items.map((i) => (i.id === itemId ? { ...i, done: checked } : i))),
    onSuccess: confirm,
    onError: () => void resync(),
  });

  const add = useMutation({
    mutationFn: (text: string) =>
      data(
        api().POST('/api/v1/canvases/{id}/items', {
          params: { path: { id: canvasId } },
          body: { text },
        }),
      ),
    onSuccess: confirm,
  });

  const remove = useMutation({
    mutationFn: (itemId: string) =>
      data(
        api().DELETE('/api/v1/canvases/{id}/items/{itemId}', {
          params: { path: { id: canvasId, itemId } },
        }),
      ),
    onMutate: (itemId) => edit((items) => items.filter((i) => i.id !== itemId)),
    onSuccess: confirm,
    onError: () => void resync(),
  });

  return { toggle, add, remove };
}

// ---------------------------------------------------------------------------------------------
// Questions

/** Questions bots asked the user that still wait for an answer, newest first. */
export function useQuestions() {
  return useQuery({
    queryKey: keys.questions,
    queryFn: async () => (await data(api().GET('/api/v1/questions'))).items,
  });
}

/** Sets a question aside without answering it (the bot is not told). */
export function useDismissQuestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      data(api().POST('/api/v1/questions/{id}/dismiss', { params: { path: { id } } })),
    onMutate: (id) =>
      client.setQueryData<Question[]>(keys.questions, (list) => list?.filter((q) => q.id !== id)),
    onError: () => void client.invalidateQueries({ queryKey: keys.questions }),
  });
}

export function useAnswerQuestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, answer }: { id: string; answer: string }) =>
      data(
        api().POST('/api/v1/questions/{id}/answer', {
          params: { path: { id } },
          body: { answer },
        }),
      ),
    onSuccess: (question) =>
      client.setQueryData<Question[]>(keys.questions, (list) =>
        list?.filter((q) => q.id !== question.id),
      ),
    // Answered meanwhile on another device, or the bot moved on: refresh.
    onError: () => void client.invalidateQueries({ queryKey: keys.questions }),
  });
}

// ---------------------------------------------------------------------------------------------
// Notifications

/** The latest 100, newest first, with the unread count (digests left out). */
export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => data(api().GET('/api/v1/notifications')),
  });
}

/** Marks some notifications read (all of them without ids). */
export function useMarkNotificationsRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      done(api().POST('/api/v1/notifications/read', { body: ids ? { ids } : {} })),
    onMutate: (ids) =>
      client.setQueryData<NotificationList>(keys.notifications, (list) =>
        list ? markRead(list, ids) : list,
      ),
    onSettled: () => void client.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** Deletes every notification (on all devices: the hub tells them). */
export function useClearNotifications() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => done(api().DELETE('/api/v1/notifications')),
    onSuccess: () =>
      client.setQueryData<NotificationList>(keys.notifications, { items: [], unread: 0 }),
  });
}

// ---------------------------------------------------------------------------------------------
// System (global pause)

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
    onSuccess: (settings) => client.setQueryData(keys.system, settings),
  });
}
