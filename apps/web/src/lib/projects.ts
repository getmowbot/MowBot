import type { Connector, Project } from '@mowbot/contract';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { api } from './auth';

/** The folders shared from the user's computers, by name. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/projects');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** The computers linked through the desktop app. */
export function useConnectors() {
  return useQuery({
    queryKey: ['connectors'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/connectors');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

function upsert<T extends { id: string }>(list: T[] | undefined, item: T): T[] | undefined {
  if (!list) return list;
  return list.some((other) => other.id === item.id)
    ? list.map((other) => (other.id === item.id ? item : other))
    : [...list, item];
}

export function setProject(queryClient: QueryClient, project: Project): void {
  queryClient.setQueryData<Project[]>(['projects'], (list) => upsert(list, project));
}

export function removeProject(queryClient: QueryClient, projectId: string): void {
  queryClient.setQueryData<Project[]>(['projects'], (list) =>
    list?.filter((project) => project.id !== projectId),
  );
}

export function setConnector(queryClient: QueryClient, connector: Connector): void {
  queryClient.setQueryData<Connector[]>(['connectors'], (list) => upsert(list, connector));
}

export function removeConnector(queryClient: QueryClient, connectorId: string): void {
  queryClient.setQueryData<Connector[]>(['connectors'], (list) =>
    list?.filter((connector) => connector.id !== connectorId),
  );
}

// The desktop app around this page (Tauri), when there is one: it shares this computer's folders.

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const tauri = () =>
  (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;

export const inDesktopApp = () => tauri() !== null;

export interface SharedFolder {
  key: string;
  name: string;
  path: string;
}

/** What the desktop app's connector says about itself. */
export interface DesktopStatus {
  linked: boolean;
  connected: boolean;
  hubUrl: string | null;
  hostname: string;
  os: string;
  shell: string;
  version: string;
  projects: SharedFolder[];
  lastError: string | null;
}

const invoke = <T>(command: string, args?: Record<string, unknown>) => {
  const app = tauri();
  if (!app) return Promise.reject(new Error('Not in the desktop app'));
  return app.invoke<T>(command, args);
};

export const desktop = {
  status: () => invoke<DesktopStatus>('connector_status'),
  link: (token: string) => invoke<void>('connector_link', { token }),
  pickFolder: () => invoke<string | null>('project_pick'),
  share: (name: string, path: string) => invoke<SharedFolder>('project_add', { name, path }),
  unshare: (key: string) => invoke<void>('project_remove', { key }),
  /** Shows the app's page to type another hub's address. */
  changeHub: () => invoke<void>('hub_change'),
  /** Asks the release feed for a newer version of the app (null: up to date). */
  checkUpdate: () => invoke<DesktopUpdate | null>('update_check'),
  /** Installs the newer version; the app restarts on it. */
  installUpdate: () => invoke<void>('update_install'),
};

/** A newer version of the desktop app. */
export interface DesktopUpdate {
  version: string;
  current: string;
  notes: string | null;
}

/** The connector of this computer, followed while the page is open. */
export function useDesktopStatus() {
  return useQuery({
    queryKey: ['desktop-status'],
    enabled: inDesktopApp(),
    refetchInterval: 3_000,
    queryFn: desktop.status,
  });
}
