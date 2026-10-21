import type { AttachmentUpload, Bot, Mention, Message, Task } from '@mowbot/contract';
import {
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import type { PendingAttachment } from './attachments';
import {
  type Conversation,
  markPressed,
  mergeLatest,
  prependOlder,
  upsertMessage,
} from './message-cache';
import { keys } from './query-keys';
import { api } from './session';
import { postFile } from './uploads';

export { keys };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The event stream keeps the cache fresh; it triggers a refetch on (re)connect.
      staleTime: 30_000,
      retry: 2,
    },
  },
});

/** Unwraps an openapi-fetch result, throwing the problem details on error. */
export async function data<T>(call: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const { data: value, error } = await call;
  if (error !== undefined || value === undefined) throw error ?? new Error('Empty response');
  return value;
}

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: () => data(api().GET('/api/v1/me')) });
}

export function useBots() {
  return useQuery({
    queryKey: keys.bots,
    queryFn: async () => (await data(api().GET('/api/v1/bots'))).items,
  });
}

export function useBot(botId: string | undefined) {
  const bots = useBots();
  return { ...bots, data: bots.data?.find((bot) => bot.id === botId) };
}

export function useTeams() {
  return useQuery({
    queryKey: keys.teams,
    queryFn: async () => (await data(api().GET('/api/v1/teams'))).items,
  });
}

export function useComputers() {
  return useQuery({
    queryKey: keys.computers,
    queryFn: async () => (await data(api().GET('/api/v1/computers'))).items,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: async () => (await data(api().GET('/api/v1/providers'))).items,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: keys.tasks,
    queryFn: async () => (await data(api().GET('/api/v1/tasks'))).items,
  });
}

const FEED_PAGE = 40;

/** What bots write to each other, newest first, paged with `before`. */
export function useFeed() {
  return useInfiniteQuery({
    queryKey: keys.feed,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      data(
        api().GET('/api/v1/feed', {
          params: { query: { limit: FEED_PAGE, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Pages come oldest → newest: flatten newest first.
    select: (result) => result.pages.flatMap((page) => [...page.items].reverse()),
  });
}

const MESSAGES_PAGE = 40;

function fetchMessages(botId: string, before?: string): Promise<Conversation> {
  return data(
    api().GET('/api/v1/bots/{id}/messages', {
      params: {
        path: { id: botId },
        query: { limit: MESSAGES_PAGE, ...(before ? { before } : {}) },
      },
    }),
  );
}

/** A conversation: the latest page live from events, older pages loaded on demand. */
export function useConversation(botId: string | undefined) {
  const client = useQueryClient();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const query = useQuery({
    queryKey: keys.messages(botId ?? ''),
    enabled: Boolean(botId),
    queryFn: async () => {
      const latest = await fetchMessages(botId as string);
      return mergeLatest(client.getQueryData<Conversation>(keys.messages(botId as string)), latest);
    },
  });

  const loadOlder = async () => {
    const cursor = query.data?.nextCursor;
    if (!botId || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await fetchMessages(botId, cursor);
      client.setQueryData<Conversation>(keys.messages(botId), (current) =>
        current ? prependOlder(current, older) : older,
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  return { ...query, loadOlder, loadingOlder };
}

/** The message a bot is streaming (from events), to tell "thinking" from "working". */
export function useLiveMessage(botId: string) {
  return useQuery<Message | null>({
    queryKey: keys.live(botId),
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  }).data;
}

/**
 * A message to send: its text, what it points at with @ (bots, teams, files), and the files
 * picked for it (uploaded to the bot's inbox first).
 */
export interface Outgoing {
  text: string;
  mentions?: Mention[];
  files?: PendingAttachment[];
}

/** A message the hub took: in the conversation at once (its events may come after). */
function useAddMessage() {
  const client = useQueryClient();
  return (message: Message) =>
    client.setQueryData<Conversation>(keys.messages(message.botId), (current) =>
      current && !current.items.some((m) => m.id === message.id)
        ? { ...current, items: [...current.items, message] }
        : current,
    );
}

export function useSendMessage(botId: string) {
  const added = useAddMessage();
  return useMutation({
    mutationFn: async ({ text, mentions, files }: Outgoing) => {
      // One file at a time: a phone's upload is a native transfer each.
      const attachments: { path: string }[] = [];
      for (const file of files ?? []) {
        const uploaded = (await postFile(
          `/api/v1/bots/${encodeURIComponent(botId)}/attachments`,
          file,
        )) as AttachmentUpload;
        attachments.push(...uploaded.items.map((item) => ({ path: item.path })));
      }
      return data(
        api().POST('/api/v1/bots/{id}/messages', {
          params: { path: { id: botId } },
          body: {
            text,
            ...(mentions?.length ? { mentions } : {}),
            ...(attachments.length ? { attachments } : {}),
          },
        }),
      );
    },
    onSuccess: added,
  });
}

/** A recording to send as a voice message (an m4a file, from the recorder). */
export interface OutgoingVoice {
  uri: string;
  durationMs: number;
  peaks: number[];
}

/** A voice message: shown at once with its waveform; the transcript follows by events. */
export function useSendVoice(botId: string) {
  const added = useAddMessage();
  return useMutation({
    mutationFn: async ({ uri, durationMs, peaks }: OutgoingVoice) =>
      (await postFile(
        `/api/v1/bots/${encodeURIComponent(botId)}/messages/voice`,
        { uri, name: 'voice.m4a', mimeType: 'audio/mp4' },
        { durationMs: String(Math.round(durationMs)), peaks: peaks.join(',') },
      )) as Message,
    onSuccess: added,
  });
}

/** Transcribes again a voice message the bot could not hear. */
export function useRetryTranscript(botId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      data(
        api().POST('/api/v1/bots/{id}/messages/{messageId}/transcribe', {
          params: { path: { id: botId, messageId } },
        }),
      ),
    onSuccess: (message) =>
      client.setQueryData<Conversation>(keys.messages(message.botId), (current) =>
        current ? upsertMessage(current, message) : current,
      ),
  });
}

/**
 * A card's button pressed in a message: its answer reaches the bot as the user's message (once
 * per card). The choice shows at once; the hub's version replaces it, or a refetch when it
 * disagrees (answered meanwhile on another device: `card_answered`).
 */
export function usePressCard(botId: string) {
  const client = useQueryClient();
  const key = keys.messages(botId);
  return useMutation({
    mutationFn: ({
      messageId,
      part,
      button,
    }: {
      messageId: string;
      part: number;
      button: number;
      label: string;
    }) =>
      data(
        api().POST('/api/v1/bots/{id}/messages/{messageId}/press', {
          params: { path: { id: botId, messageId } },
          body: { part, button },
        }),
      ),
    onMutate: ({ messageId, part, label }) =>
      client.setQueryData<Conversation>(key, (current) =>
        current ? markPressed(current, messageId, part, label) : current,
      ),
    onSuccess: (message) =>
      client.setQueryData<Conversation>(key, (current) =>
        current ? upsertMessage(current, message) : current,
      ),
    onError: () => void client.invalidateQueries({ queryKey: key }),
  });
}

export function useStopBot(botId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api().POST('/api/v1/bots/{id}/stop', { params: { path: { id: botId } } }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.bots }),
  });
}

export function useCancelTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (task: Task) =>
      data(
        api().PATCH('/api/v1/tasks/{id}', {
          params: { path: { id: task.id } },
          body: { status: 'cancelled' },
        }),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: keys.tasks }),
  });
}

/**
 * Empties the Activity tab: finished and cancelled tasks are deleted and the feed starts over
 * (ongoing tasks stay; bots keep their conversations).
 */
export function useClearActivity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { error } = await api().POST('/api/v1/activity/clear');
      if (error !== undefined) throw error;
    },
    onSuccess: () => {
      client.setQueryData<Task[]>(keys.tasks, (list) =>
        list?.filter((task) => task.status !== 'done' && task.status !== 'cancelled'),
      );
      void client.invalidateQueries({ queryKey: keys.tasks });
      void client.invalidateQueries({ queryKey: keys.feed });
    },
  });
}

export function botsById(bots: Bot[] | undefined): Map<string, Bot> {
  return new Map((bots ?? []).map((bot) => [bot.id, bot]));
}
