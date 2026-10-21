import type {
  VaultItem,
  VaultItemCreate,
  VaultItemUpdate,
  VaultSessionCapture,
} from '@mowbot/contract';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import i18n from '../i18n';
import { problemCode } from './hub-url';
import { data, keys } from './queries';
import { api } from './session';

/** Hub problems worded in the app's language; the others fall back to a generic message. */
const WORDED = [
  'invalid_totp',
  'invalid_site',
  'empty_login',
  'no_session',
  'computer_not_running',
  'session_values',
  'not_found',
] as const;

/** The message to show for a failed vault action. */
export function vaultError(error: unknown, fallback: string): string {
  const code = problemCode(error);
  if (code === 'validation_failed' || code === 'rate_limited') return i18n.t(`errors.${code}`);
  if (code && (WORDED as readonly string[]).includes(code)) {
    return i18n.t(`vault.problems.${code as (typeof WORDED)[number]}`);
  }
  return fallback;
}

async function noContent(call: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await call;
  if (error !== undefined) throw error;
}

/** Replaces the entry with the same id, or appends it. */
function upsert(list: VaultItem[] | undefined, item: VaultItem): VaultItem[] | undefined {
  if (!list) return list;
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item];
}

/** An entry as the hub returned it, and one more line in its history. */
function putItem(client: QueryClient, item: VaultItem) {
  client.setQueryData<VaultItem[]>(keys.vault, (list) => upsert(list, item));
  void client.invalidateQueries({ queryKey: keys.vaultEvents(item.id) });
}

/** Every entry, without its values (kept live by `vault.updated` / `vault.deleted`). */
export function useVault() {
  return useQuery({
    queryKey: keys.vault,
    queryFn: async () => (await data(api().GET('/api/v1/vault/items'))).items,
  });
}

export function useVaultItem(itemId: string | undefined) {
  const vault = useVault();
  return { ...vault, data: vault.data?.find((item) => item.id === itemId) };
}

/** An entry's history, newest first. */
export function useVaultEvents(itemId: string | undefined) {
  return useQuery({
    queryKey: keys.vaultEvents(itemId ?? ''),
    enabled: Boolean(itemId),
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/vault/items/{id}/events', {
            params: { path: { id: itemId as string } },
          }),
        )
      ).items,
  });
}

/** Stores a login or a secret. */
export function useCreateVaultItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: VaultItemCreate) => data(api().POST('/api/v1/vault/items', { body })),
    onSuccess: (item) => putItem(client, item),
  });
}

/** Labels and policy; values replaced when typed, removed when null. */
export function useUpdateVaultItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: VaultItemUpdate }) =>
      data(api().PATCH('/api/v1/vault/items/{id}', { params: { path: { id } }, body })),
    onSuccess: (item) => putItem(client, item),
  });
}

export function useDeleteVaultItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      noContent(api().DELETE('/api/v1/vault/items/{id}', { params: { path: { id } } })),
    onSuccess: (_, id) => {
      client.setQueryData<VaultItem[]>(keys.vault, (list) => list?.filter((i) => i.id !== id));
      client.removeQueries({ queryKey: keys.vaultEvents(id) });
    },
  });
}

/** Takes back the permission given to a bot for an `ask` entry. */
export function useRevokeVaultGrant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, botId }: { id: string; botId: string }) =>
      data(
        api().DELETE('/api/v1/vault/items/{id}/grants/{botId}', {
          params: { path: { id, botId } },
        }),
      ),
    onSuccess: (item) => putItem(client, item),
  });
}

/** Sites with cookies in a running computer's Chrome, read when asked (cookies change fast). */
export function useComputerSites(computerId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.computerSites(computerId ?? ''),
    enabled: enabled && Boolean(computerId),
    staleTime: 0,
    retry: false,
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/computers/{id}/sites', {
            params: { path: { id: computerId as string } },
          }),
        )
      ).items,
  });
}

/** Saves (or refreshes) a site's session from a running computer's Chrome. */
export function useCaptureSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: VaultSessionCapture) => data(api().POST('/api/v1/vault/sessions', { body })),
    onSuccess: (item, body) => {
      putItem(client, item);
      // The site now shows as saved.
      void client.invalidateQueries({ queryKey: keys.computerSites(body.computerId) });
    },
  });
}
