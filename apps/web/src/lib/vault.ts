import type { VaultField, VaultItem, VaultItemUpdate, VaultKind } from '@mowbot/contract';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { i18n } from '../i18n';
import { api } from './auth';

export const VAULT_KINDS: readonly VaultKind[] = ['session', 'login', 'secret'];

/** Every entry, without its values (they never leave the hub). */
export function useVault() {
  return useQuery({
    queryKey: ['vault'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/vault/items');
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** An entry's history, newest first. */
export function useVaultEvents(itemId: string | null) {
  return useQuery({
    queryKey: ['vault', itemId, 'events'],
    enabled: Boolean(itemId),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/vault/items/{id}/events', {
        params: { path: { id: itemId as string } },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** Sites with cookies in a computer's Chrome (only a running one can be read). */
export function useComputerSites(computerId: string | null, running: boolean) {
  return useQuery({
    queryKey: ['computer-sites', computerId],
    enabled: Boolean(computerId) && running,
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/computers/{id}/sites', {
        params: { path: { id: computerId as string } },
      });
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** Puts a saved, refreshed or changed entry in the cache, and refreshes its history. */
export function setVaultItem(queryClient: QueryClient, item: VaultItem): void {
  queryClient.setQueryData<VaultItem[]>(['vault'], (list) => {
    if (!list) return list;
    return list.some((i) => i.id === item.id)
      ? list.map((i) => (i.id === item.id ? item : i))
      : [...list, item];
  });
  void queryClient.invalidateQueries({ queryKey: ['vault', item.id] });
}

/** Entries of each kind, by service then oldest first (as the hub lists them). */
export function byKind(items: VaultItem[]): Record<VaultKind, VaultItem[]> {
  const sorted = [...items].sort(
    (a, b) =>
      a.service.localeCompare(b.service, undefined, { sensitivity: 'base' }) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return {
    session: sorted.filter((item) => item.kind === 'session'),
    login: sorted.filter((item) => item.kind === 'login'),
    secret: sorted.filter((item) => item.kind === 'secret'),
  };
}

/** The values an entry of this kind can hold (a session holds cookies, captured from a PC). */
export function fieldsOf(kind: VaultKind): VaultField[] {
  if (kind === 'login') return ['username', 'password', 'totp'];
  if (kind === 'secret') return ['value'];
  return [];
}

/** What bots write to use a value without seeing it: `{{vault:ab12cd34.password}}`. */
export const placeholderOf = (ref: string, field: VaultField): string =>
  `{{vault:${ref}.${field}}}`;

/** "google.com, github.com" (commas, spaces or lines) → distinct sites. */
export function parseSites(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter(Boolean))];
}

/** Service, account, sites and notes typed in a form; empty texts clear them. */
export function labelsOf(form: FormData) {
  const value = (name: string) => String(form.get(name) ?? '').trim();
  return {
    service: value('service'),
    account: value('account') || null,
    sites: parseSites(value('sites')),
    notes: value('notes') || null,
  };
}

type Values = Pick<VaultItemUpdate, 'username' | 'password' | 'totp' | 'value'>;

/** Values typed in masked fields: an empty one is left unchanged, a removed one is cleared. */
export function valuesOf(
  form: FormData,
  fields: VaultField[],
  removed: ReadonlySet<VaultField> = new Set(),
): Values {
  const values: Partial<Record<VaultField, string | null>> = {};
  for (const field of fields) {
    const typed = String(form.get(field) ?? '');
    if (removed.has(field)) values[field] = null;
    else if (typed.trim()) values[field] = typed;
  }
  return values as Values;
}

/** The hub's history details (written in French for the bots), in the app's language. */
const DETAILS = {
  'valeurs remplacées': 'replaced',
  'rafraîchie avant usage': 'refreshed',
  'fin de prise de main': 'takeover',
} as const;

const isField = (detail: string): detail is VaultField =>
  ['username', 'password', 'totp', 'value'].includes(detail);

export function detailLabel(detail: string): string {
  if (detail in DETAILS) {
    return i18n.t(`vault.details.${DETAILS[detail as keyof typeof DETAILS]}`);
  }
  if (isField(detail)) return i18n.t(`vault.fields.${detail}`);
  return detail;
}
