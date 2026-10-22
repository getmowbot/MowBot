import { OPENAI_COMPATIBLE_PRESETS, type Provider, type ProviderKind } from '@mowbot/contract';
import type { TFunction } from 'i18next';

/** One editable header line: `key` keeps React rows stable while names change. */
export interface HeaderRow {
  key: string;
  name: string;
  value: string;
}

/** Command Code only routes to upstreams that keep nothing when this header is set. */
export const ZDR_HEADER = 'x-cmd-zdr';

/** Same rules as the hub (`providerHeadersSchema`): token characters, one line, 20 at most. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
export const MAX_HEADERS = 20;

let sequence = 0;
const nextKey = () => `h${++sequence}`;

export function headerRow(name = '', value = ''): HeaderRow {
  return { key: nextKey(), name, value };
}

export function headerRows(headers: Record<string, string>): HeaderRow[] {
  return Object.entries(headers).map(([name, value]) => headerRow(name, value));
}

/** The record sent to the hub: trimmed, blank names left out. */
export function headersRecord(rows: HeaderRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value.trim()]),
  );
}

export type HeaderProblem = 'headerName' | 'headerValue' | 'headerDuplicate' | 'headerTooMany';

/** What the hub would refuse, checked before sending. */
export function headersProblem(rows: HeaderRow[]): HeaderProblem | null {
  const named = rows.filter((row) => row.name.trim());
  if (named.length > MAX_HEADERS) return 'headerTooMany';
  const seen = new Set<string>();
  for (const row of named) {
    const name = row.name.trim();
    if (name.length > 100 || !HEADER_NAME.test(name)) return 'headerName';
    if (/[\r\n]/.test(row.value) || row.value.trim().length > 2000) return 'headerValue';
    const lower = name.toLowerCase();
    if (seen.has(lower)) return 'headerDuplicate';
    seen.add(lower);
  }
  // A value without a name would be silently dropped: say so.
  if (rows.some((row) => !row.name.trim() && row.value.trim())) return 'headerName';
  return null;
}

export function sameHeaders(a: Record<string, string>, b: Record<string, string>): boolean {
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return (
    left.length === right.length &&
    left.every(([name, value], i) => right[i]?.[0] === name && right[i]?.[1] === value)
  );
}

export function hasZdr(rows: HeaderRow[]): boolean {
  return rows.some((row) => row.name.trim().toLowerCase() === ZDR_HEADER);
}

/** Adds `x-cmd-zdr: 1`, or removes it. */
export function toggleZdr(rows: HeaderRow[]): HeaderRow[] {
  return hasZdr(rows)
    ? rows.filter((row) => row.name.trim().toLowerCase() !== ZDR_HEADER)
    : [...rows, headerRow(ZDR_HEADER, '1')];
}

/** `https://api.openai.com/v1` → `api.openai.com/v1`, for compact rows. */
export function urlLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** What the hub's `z.url()` would accept, roughly: http(s) with a host. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[^\s/?#]+[^\s]*$/i.test(value.trim());
}

/** Product names stay as they are; only the generic kinds are worded (appAdmin.models.kinds). */
export const PROVIDER_KINDS = [
  { kind: 'command-code', name: 'Command Code' },
  { kind: 'openai', name: 'OpenAI' },
  { kind: 'openai-chatgpt', name: null },
  { kind: 'anthropic', name: 'Anthropic' },
  { kind: 'openai-compatible', name: null },
] as const satisfies readonly { kind: ProviderKind; name: string | null }[];

/** What can be added: the providers MowBot speaks to natively, well-known services, any other. */
export interface ProviderOption {
  id: string;
  kind: ProviderKind;
  name: string;
  hint: string;
  /** A preset's address, filled in. */
  baseUrl?: string;
  /** No key needed (Ollama). */
  keyless?: boolean;
}

/** In the order shown (as on the web). */
export function providerOptions(t: TFunction): ProviderOption[] {
  const native = (kind: ProviderKind): ProviderOption => ({
    id: kind,
    kind,
    name: kindLabel(kind, t),
    hint: kindHint(kind, t),
  });
  return [
    native('anthropic'),
    native('openai'),
    native('openai-chatgpt'),
    ...OPENAI_COMPATIBLE_PRESETS.map((preset) => ({
      id: preset.id,
      kind: 'openai-compatible' as const,
      name: preset.name,
      baseUrl: preset.baseUrl,
      keyless: preset.keyAt === null,
      hint: preset.keyAt
        ? t('appAdmin.models.kinds.presetHint', { site: preset.keyAt })
        : t('appAdmin.models.kinds.ollamaHint'),
    })),
    native('command-code'),
    native('openai-compatible'),
  ];
}

/** Whether adding this option asks for a key: all but a generic endpoint or a local Ollama. */
export const keyRequired = (option: ProviderOption) =>
  !option.keyless && (option.kind !== 'openai-compatible' || Boolean(option.baseUrl));

/** Signed in from the desktop app ("Sign in with ChatGPT"), not added with a key here. */
export const isChatgpt = (kind: ProviderKind) => kind === 'openai-chatgpt';

/** Where to get the desktop app, which signs in with ChatGPT. */
export const DESKTOP_DOWNLOAD_URL = 'https://github.com/getmowbot/MowBot/releases/latest';

export function kindLabel(kind: ProviderKind, t: TFunction): string {
  if (kind === 'openai-chatgpt') return t('appAdmin.models.kinds.chatgpt');
  return (
    PROVIDER_KINDS.find((option) => option.kind === kind)?.name ??
    t('appAdmin.models.kinds.compatible')
  );
}

export function kindHint(kind: ProviderKind, t: TFunction): string {
  switch (kind) {
    case 'command-code':
      return t('appAdmin.models.kinds.commandCodeHint');
    case 'openai':
      return t('appAdmin.models.kinds.openaiHint');
    case 'openai-chatgpt':
      return t('appAdmin.models.kinds.chatgptHint');
    case 'anthropic':
      return t('appAdmin.models.kinds.anthropicHint');
    case 'openai-compatible':
      return t('appAdmin.models.kinds.compatibleHint');
  }
}

/** A ChatGPT provider's account, in one line: email, plan, state of the session. */
export function chatgptSummary(provider: Provider, t: TFunction): string | null {
  const account = provider.chatgpt;
  if (!account) return null;
  const plan = account.planType
    ? t('appAdmin.models.chatgpt.plan', {
        plan: account.planType.charAt(0).toUpperCase() + account.planType.slice(1),
      })
    : null;
  const state =
    account.status === 'needs_sign_in'
      ? t('appAdmin.models.chatgpt.needsSignIn')
      : account.status === 'usage_limited'
        ? t('appAdmin.models.chatgpt.limited')
        : null;
  return [account.email, plan, state].filter(Boolean).join(' · ');
}

export type ProviderFormProblem = 'name' | 'url' | 'urlRequired' | 'keyRequired' | HeaderProblem;

/** Checks the fields shared by the "add" and "edit" forms. */
export function providerFormProblem(input: {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  /** Adding: the key typed, and whether one is needed (see `keyRequired`). */
  apiKey?: string;
  needsKey?: boolean;
  rows: HeaderRow[];
  /** Editing: the URL is always there (presets were filled in by the hub). */
  editing: boolean;
}): ProviderFormProblem | null {
  if (!input.name.trim()) return 'name';
  const url = input.baseUrl.trim();
  if (!url) {
    if (input.editing) return 'url';
    if (input.kind === 'openai-compatible') return 'urlRequired';
  } else if (!isHttpUrl(url)) {
    return 'url';
  }
  if (!input.editing && input.needsKey && !input.apiKey?.trim()) return 'keyRequired';
  return headersProblem(input.rows);
}
