import type { Bot, Connector, Project } from '@mowbot/contract';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

// The project a bot works in, picked in its conversation.

/** Whether this bot may work in the project (all bots, some teams, some bots). */
export function usableBy(project: Pick<Project, 'scope'>, bot: Pick<Bot, 'id' | 'teamId'>) {
  const { scope } = project;
  if (scope.kind === 'all') return true;
  if (scope.kind === 'bots') return scope.ids.includes(bot.id);
  return bot.teamId !== null && scope.ids.includes(bot.teamId);
}

/** The projects this bot may work in, by name. */
export function projectsFor(bot: Bot, projects: Project[] | undefined): Project[] {
  return (projects ?? [])
    .filter((project) => usableBy(project, bot))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The project the bot works in, while it still may. */
export function activeProject(bot: Bot, projects: Project[] | undefined): Project | null {
  const project = projects?.find((p) => p.id === bot.projectId);
  return project && usableBy(project, bot) ? project : null;
}

/** Picks the project the bot works in (null: none); every device follows through `bot.updated`. */
export function useSetBotProject(bot: Bot) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string | null) => {
      const { data, error } = await api.PUT('/api/v1/bots/{id}/project', {
        params: { path: { id: bot.id } },
        body: { projectId },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved) =>
      queryClient.setQueryData<Bot[]>(['bots'], (list) =>
        list?.map((other) => (other.id === saved.id ? saved : other)),
      ),
  });
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
};

/** The connector of this computer, followed while the page is open. */
export function useDesktopStatus() {
  return useQuery({
    queryKey: ['desktop-status'],
    enabled: inDesktopApp(),
    refetchInterval: 3_000,
    queryFn: desktop.status,
  });
}
