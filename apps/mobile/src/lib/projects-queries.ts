import type { Bot, Connector, Project, ProjectUpdate } from '@mowbot/contract';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import i18n from '../i18n';
import { problemCode } from './hub-url';
import { data, keys } from './queries';
import { api } from './session';

/** The message to show for a failed project or computer action. */
export function projectError(error: unknown, fallback: string): string {
  const code = problemCode(error);
  if (code === 'validation_failed' || code === 'rate_limited') return i18n.t(`errors.${code}`);
  if (code === 'not_found') return i18n.t('projects.problems.not_found');
  return fallback;
}

async function noContent(call: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await call;
  if (error !== undefined) throw error;
}

/** Replaces the project with the same id, or appends it. */
function putProject(client: QueryClient, project: Project) {
  client.setQueryData<Project[]>(keys.projects, (list) => {
    if (!list) return list;
    return list.some((x) => x.id === project.id)
      ? list.map((x) => (x.id === project.id ? project : x))
      : [...list, project];
  });
}

/** Every shared folder (kept live by `project.updated` / `project.deleted`). */
export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: async () => (await data(api().GET('/api/v1/projects'))).items,
  });
}

export function useProject(projectId: string | undefined) {
  const projects = useProjects();
  return { ...projects, data: projects.data?.find((project) => project.id === projectId) };
}

/** The computers linked through the desktop app (kept live by `connector.*` events). */
export function useConnectors() {
  return useQuery({
    queryKey: keys.connectors,
    queryFn: async () => (await data(api().GET('/api/v1/connectors'))).items,
  });
}

/** Name, mode (`ask` / `auto`) and who may use it; folders are shared from the desktop app. */
export function useUpdateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProjectUpdate }) =>
      data(api().PATCH('/api/v1/projects/{id}', { params: { path: { id } }, body })),
    onSuccess: (project) => putProject(client, project),
  });
}

/** Picks the project a bot works in (null: none); other devices follow through `bot.updated`. */
export function useSetBotProject(botId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string | null) =>
      data(
        api().PUT('/api/v1/bots/{id}/project', {
          params: { path: { id: botId } },
          body: { projectId },
        }),
      ),
    onSuccess: (bot) =>
      client.setQueryData<Bot[]>(keys.bots, (list) =>
        list?.map((other) => (other.id === bot.id ? bot : other)),
      ),
  });
}

/** Unlinks a computer: its app's token stops working and its projects go. */
export function useUnlinkConnector() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      noContent(api().DELETE('/api/v1/connectors/{id}', { params: { path: { id } } })),
    onSuccess: (_, id) => {
      client.setQueryData<Connector[]>(keys.connectors, (list) => list?.filter((c) => c.id !== id));
      client.setQueryData<Project[]>(keys.projects, (list) =>
        list?.filter((project) => project.connectorId !== id),
      );
    },
  });
}
