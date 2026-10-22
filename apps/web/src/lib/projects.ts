import type { Bot, ChatgptCredential, Connector, Project, ProjectMirror } from '@mowbot/contract';
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

// The project's copy in the bots' workspace, kept in sync with the user's folder.

/** The mirror this bot works in (its workspace's), if there is one. */
export function mirrorFor(project: Project, bot: Pick<Bot, 'workspaceId'>): ProjectMirror | null {
  return project.mirrors.find((mirror) => mirror.workspaceId === bot.workspaceId) ?? null;
}

/** How a mirror shows: a tone for its badge, and its state in a few words. */
export type MirrorTone = 'ok' | 'busy' | 'waiting' | 'warn' | 'error';

export function mirrorTone(mirror: ProjectMirror): MirrorTone {
  if (mirror.status === 'error' || mirror.status === 'too_big') return 'error';
  if (mirror.conflicts.length > 0) return 'warn';
  if (mirror.status === 'syncing') return 'busy';
  if (mirror.status === 'pending' || mirror.status === 'waiting') return 'waiting';
  return 'ok';
}

/** The desktop app has `pick` (and the mirror's watcher) from this version. */
export const PICK_FROM = [0, 2, 5];

export function versionAtLeast(version: string | null | undefined, wanted: number[]): boolean {
  const parts = (version ?? '').split(/[.-]/).map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < wanted.length; i++) {
    const have = parts[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== wanted[i]) return have > (wanted[i] as number);
  }
  return true;
}

/** Dismisses a mirror's conflicts (or one file's): the bots' copies go to the trash. */
export function useDismissConflicts(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; path?: string }) => {
      const { data, error } = await api.POST('/api/v1/projects/{id}/conflicts/dismiss', {
        params: { path: { id: project.id } },
        body: input,
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved) => setProject(queryClient, saved),
  });
}

/** Turns the project's mirror on or off. */
export function useSetMirror(project: Project) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mirror: boolean) => {
      const { data, error } = await api.PATCH('/api/v1/projects/{id}', {
        params: { path: { id: project.id } },
        body: { mirror },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (saved) => setProject(queryClient, saved),
  });
}

/**
 * Asks a computer's desktop app to open its folder picker (from another device): the folder
 * picked there becomes the bot's active project. Resolves with it, or null when cancelled.
 */
export function usePickOnComputer(bot: Bot) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (connectorId: string) => {
      const { data, error } = await api.POST('/api/v1/connectors/{id}/pick', {
        params: { path: { id: connectorId } },
        body: { botId: bot.id },
      });
      if (error || !data) throw error;
      return data.project;
    },
    onSuccess: (project) => {
      if (project) setProject(queryClient, project);
    },
  });
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/**
 * In the desktop app: picks a folder of this computer, shares it (linking this computer first
 * if needed) and makes it the bot's active project. Resolves with the project, or null when the
 * picker was cancelled.
 */
export function useAddFolderHere(bot: Bot, computerName: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<Project | null> => {
      let status = await desktop.status();
      if (!status.linked) {
        const { data, error } = await api.POST('/api/v1/connectors', {
          body: { name: status.hostname || computerName },
        });
        if (error || !data) throw error;
        await desktop.link(data.token);
        status = await desktop.status();
      }
      const path = await desktop.pickFolder();
      if (!path) return null;
      // Already shared: that project. Otherwise shared under a free name.
      let folder = status.projects.find((shared) => samePath(shared.path, path));
      if (!folder) {
        const base = folderName(path);
        const taken = (name: string) =>
          status.projects.some((shared) => shared.name.toLowerCase() === name.toLowerCase());
        let name = base;
        for (let n = 2; taken(name); n++) name = `${base} ${n}`;
        folder = await desktop.share(name, path);
      }
      // The hub hears of it from the app: wait for the project to be there.
      const key = folder.key;
      let project: Project | undefined;
      for (let i = 0; i < 50 && !project; i++) {
        const { data } = await api.GET('/api/v1/projects');
        project = data?.items.find((p) => p.key === key);
        if (!project) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!project) throw new Error('The hub has not heard of the folder yet.');
      setProject(queryClient, project);
      const { data, error } = await api.PUT('/api/v1/bots/{id}/project', {
        params: { path: { id: bot.id } },
        body: { projectId: project.id },
      });
      if (error || !data) throw error;
      queryClient.setQueryData<Bot[]>(['bots'], (list) =>
        list?.map((other) => (other.id === data.id ? data : other)),
      );
      void queryClient.invalidateQueries({ queryKey: ['desktop-status'] });
      return project;
    },
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
  /** Asks the release feed for a newer version of the app (null: up to date). */
  checkUpdate: () => invoke<DesktopUpdate | null>('update_check'),
  /** Installs the newer version; the app restarts on it. */
  installUpdate: () => invoke<void>('update_install'),
  /**
   * "Sign in with ChatGPT" in the user's browser (0.2.3+): resolves with the tokens for the hub,
   * rejects with a `ChatgptSignInError`.
   */
  chatgptSignIn: (request: ChatgptSignInRequest) =>
    invoke<ChatgptCredential>('chatgpt_sign_in', { request }),
  /** Ends the ChatGPT sign-in waiting for the browser. */
  cancelChatgptSignIn: () => invoke<void>('chatgpt_sign_in_cancel'),
};

/** What the desktop app needs to sign in with ChatGPT (from the hub, plus the page's language). */
export interface ChatgptSignInRequest {
  hostId: string;
  agentName: string;
  clientId: string | null;
  loginHint: string | null;
  lang: string;
}

/** Why the desktop app's ChatGPT sign-in ended without tokens. */
export interface ChatgptSignInError {
  code: string;
  detail: string | null;
  /** The client OpenAI issued, to retry with it rather than register again. */
  clientId: string | null;
}

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
