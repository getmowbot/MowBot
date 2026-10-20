import type { ServerEvent } from '@mowbot/contract';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { applyServerEvent } from './event-cache';
import { queryClient } from './queries';
import { api, eventsUrl } from './session';

const MAX_BACKOFF_MS = 30_000;

let connected = false;
const listeners = new Set<() => void>();

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  for (const listener of listeners) listener();
}

/** Whether the live event stream is up (false while reconnecting). */
export function useLiveConnection(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => connected,
  );
}

/**
 * Keeps the cache in sync with the hub's WebSocket while signed in. The OS suspends sockets in
 * the background, so the stream is closed there and reopened (with a refetch) on return.
 */
export function useServerEvents() {
  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    // `inactive` (app switcher, notification center) keeps the stream; background drops it.
    let active = AppState.currentState !== 'background';

    const reconnectLater = () => {
      if (stopped || !active) return;
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt++));
    };

    async function connect() {
      if (stopped || !active || socket) return;
      const { data } = await api()
        .POST('/api/v1/events/ticket')
        .catch(() => ({ data: undefined }));
      if (stopped || !active || socket) return;
      if (!data) return reconnectLater();
      const ws = new WebSocket(eventsUrl(data.ticket));
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (message) => {
        try {
          applyServerEvent(queryClient, JSON.parse(String(message.data)) as ServerEvent);
        } catch {
          // A malformed event is dropped; the next `ready` resyncs everything.
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        setConnected(false);
        reconnectLater();
      };
    }

    const subscription = AppState.addEventListener('change', (next) => {
      const nowActive = next !== 'background';
      if (nowActive === active) return;
      active = nowActive;
      if (active) {
        attempt = 0;
        void connect();
        return;
      }
      clearTimeout(timer);
      const ws = socket;
      socket = null;
      ws?.close();
      setConnected(false);
    });

    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      subscription.remove();
      const ws = socket;
      socket = null;
      ws?.close();
      setConnected(false);
    };
  }, []);
}
