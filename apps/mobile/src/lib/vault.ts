import type {
  Computer,
  VaultEvent,
  VaultField,
  VaultItem,
  VaultItemCreate,
  VaultItemUpdate,
  VaultKind,
  VaultPolicy,
} from '@mowbot/contract';
import type { TFunction } from 'i18next';
import { problemCode } from './hub-url';
import { timeAgo } from './time';

/**
 * Pure logic of the vault screens (no React, no native modules): grouping, the rows' text,
 * placeholders, history labels, what the forms send, and the forms bots ask with in a chat.
 */

/** Groups in the order the list shows them. */
export const VAULT_KINDS: readonly VaultKind[] = ['session', 'login', 'secret'];

/** Values of a login, in the order the forms show them. */
export const LOGIN_FIELDS = ['username', 'password', 'totp'] as const;
export type LoginField = (typeof LOGIN_FIELDS)[number];

const FIELD_ORDER: readonly VaultField[] = [...LOGIN_FIELDS, 'value'];

/** The hub takes 20 sites per entry. */
export const MAX_SITES = 20;

type Named = Pick<Computer, 'id' | 'name'>;

const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** By service, then account (events append new entries at the end). */
export function sortVault(items: readonly VaultItem[]): VaultItem[] {
  return [...items].sort(
    (a, b) =>
      byText(a.service, b.service) ||
      byText(a.account ?? '', b.account ?? '') ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export interface VaultGroup {
  kind: VaultKind;
  items: VaultItem[];
}

/** Sessions, logins, secrets: only the groups that have entries. */
export function groupVault(items: readonly VaultItem[]): VaultGroup[] {
  const sorted = sortVault(items);
  return VAULT_KINDS.map((kind) => ({
    kind,
    items: sorted.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Text

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Google (joris@gmail.com)", as the hub names an entry. */
export function itemLabel(item: Pick<VaultItem, 'service' | 'account'>): string {
  return item.account ? `${item.service} (${item.account})` : item.service;
}

/** "Nom d'utilisateur, mot de passe, 2FA": what a login or a secret holds. */
export function fieldsText(fields: readonly VaultField[], t: TFunction): string {
  return capitalize(
    FIELD_ORDER.filter((field) => fields.includes(field))
      .map((field) => t(`vault.fieldNames.${field}`))
      .join(', '),
  );
}

/** A computer's name, "Deleted PC" once it is gone. */
export function computerName(
  computerId: string | null,
  computers: readonly Named[] | undefined,
  t: TFunction,
): string {
  const computer = computerId ? computers?.find((c) => c.id === computerId) : undefined;
  return computer?.name ?? t('vault.deletedPc');
}

/** "12 cookies · 1 stockage local" */
export function sessionContents(session: VaultItem['session'], t: TFunction): string | null {
  if (!session) return null;
  return [
    t('vault.cookies', { count: session.cookies }),
    session.origins > 0 ? t('vault.origins', { count: session.origins }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

interface TextContext {
  computers: readonly Named[] | undefined;
  t: TFunction;
  language: string;
  now?: number;
}

/**
 * The text under a row's service: account and sites, then where a session comes from (and how
 * fresh it is) or what a login holds.
 */
export function itemHint(item: VaultItem, { computers, t, language, now }: TextContext): string {
  const labels = [item.account, item.sites.join(', ')].filter(Boolean).join(' · ');
  const holds =
    item.kind === 'session'
      ? [
          computerName(item.computerId, computers, t),
          item.capturedAt
            ? t('vault.captured', { time: timeAgo(item.capturedAt, t, language, now) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : fieldsText(item.fields, t);
  return [labels, holds].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Placeholders

/** What a bot writes for a value: `{{vault:3f2a9c1b.password}}`. */
export function placeholder(ref: string, field: VaultField): string {
  return `{{vault:${ref}.${field}}}`;
}

/** The placeholders of an entry's stored values (sessions have none: bots load them). */
export function placeholders(
  item: Pick<VaultItem, 'kind' | 'ref' | 'fields'>,
): { field: VaultField; text: string }[] {
  if (item.kind === 'session') return [];
  return FIELD_ORDER.filter((field) => item.fields.includes(field)).map((field) => ({
    field,
    text: placeholder(item.ref, field),
  }));
}

// ---------------------------------------------------------------------------------------------
// History

/** Codes the hub writes for the app to word in its own language. */
const KNOWN_DETAILS: Record<string, 'valuesReplaced' | 'refreshed' | 'takeoverEnd'> = {
  values_replaced: 'valuesReplaced',
  refreshed: 'refreshed',
  takeover_end: 'takeoverEnd',
  // Older lines, written in French before the hub sent codes.
  'valeurs remplacées': 'valuesReplaced',
  'rafraîchie avant usage': 'refreshed',
  'fin de prise de main': 'takeoverEnd',
};

export function detailText(detail: string | null, t: TFunction): string | null {
  if (!detail) return null;
  const known = KNOWN_DETAILS[detail];
  if (known) return t(`vault.details.${known}`);
  // A use names the field the bot filled in.
  if ((FIELD_ORDER as readonly string[]).includes(detail)) {
    return t(`vault.fieldNames.${detail as VaultField}`);
  }
  return detail;
}

export interface EventText {
  label: string;
  /** Where it happened and how ("PC de Nova · mot de passe"). */
  hint: string | null;
}

/** One history line, with bot and PC names. */
export function eventText(
  event: VaultEvent,
  names: { bots: ReadonlyMap<string, { name: string }>; computers: readonly Named[] | undefined },
  t: TFunction,
): EventText {
  const bot = event.botId ? (names.bots.get(event.botId)?.name ?? t('common.deletedBot')) : null;
  const who = bot ?? t('common.you');
  let label: string;
  switch (event.action) {
    case 'created':
      label = t('vault.history.created', { who });
      break;
    case 'updated':
      label = t('vault.history.updated');
      break;
    case 'captured':
      label = bot ? t('vault.history.capturedBy', { bot }) : t('vault.history.captured');
      break;
    default:
      label = t(`vault.history.${event.action}`, { bot: who });
  }
  const pc = event.computerId ? computerName(event.computerId, names.computers, t) : null;
  const hint = [pc, detailText(event.detail, t)].filter(Boolean).join(' · ');
  return { label, hint: hint || null };
}

// ---------------------------------------------------------------------------------------------
// Forms

/** "google.com, Youtube.com  mail.google.com" → three sites, lower case, without repeats. */
export function parseSites(text: string): string[] {
  const sites: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const site = part.trim().toLowerCase();
    if (site && !sites.includes(site)) sites.push(site);
  }
  return sites;
}

export function sitesText(sites: readonly string[]): string {
  return sites.join(', ');
}

/** The service name the hub gives a session when none is typed: `google.com` → "Google". */
export function serviceName(site: string): string {
  return capitalize(site.split('.')[0] ?? site);
}

/** "12 cookies · déjà enregistrée": a site of a computer's Chrome. */
export function siteHint(site: { cookies: number; itemId: string | null }, t: TFunction): string {
  return [
    t('vault.cookies', { count: site.cookies }),
    site.itemId ? t('vault.session.saved') : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Sites whose name contains what was typed. */
export function filterSites<T extends { site: string }>(sites: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? sites.filter((s) => s.site.includes(needle)) : [...sites];
}

/** Service, account, sites and notes as typed. */
export interface LabelDraft {
  service: string;
  account: string;
  sites: string;
  notes: string;
}

export const EMPTY_LABELS: LabelDraft = { service: '', account: '', sites: '', notes: '' };

export function labelDraft(item: VaultItem): LabelDraft {
  return {
    service: item.service,
    account: item.account ?? '',
    sites: sitesText(item.sites),
    notes: item.notes ?? '',
  };
}

/** Values as typed: write-only, empty means "keep what is stored". */
export interface ValueDraft {
  username: string;
  password: string;
  totp: string;
  value: string;
}

export const EMPTY_VALUES: ValueDraft = { username: '', password: '', totp: '', value: '' };

export type VaultFormProblem = 'service' | 'sites' | 'login' | 'value';

export function labelsProblem(labels: LabelDraft): VaultFormProblem | null {
  if (!labels.service.trim()) return 'service';
  if (parseSites(labels.sites).length > MAX_SITES) return 'sites';
  return null;
}

/** Passwords keep their spaces; names, seeds and keys lose the ones pasted around them. */
function typedValues(values: ValueDraft) {
  return {
    username: values.username.trim(),
    password: values.password,
    totp: values.totp.trim(),
    value: values.value.trim(),
  };
}

export function newItemProblem(
  kind: 'login' | 'secret',
  labels: LabelDraft,
  values: ValueDraft,
): VaultFormProblem | null {
  const problem = labelsProblem(labels);
  if (problem) return problem;
  const typed = typedValues(values);
  if (kind === 'login' && !typed.username && !typed.password && !typed.totp) return 'login';
  if (kind === 'secret' && !typed.value) return 'value';
  return null;
}

/** What creating a login or a secret sends (empty fields left out). */
export function createBody(
  kind: 'login' | 'secret',
  labels: LabelDraft,
  values: ValueDraft,
  policy: VaultPolicy,
): VaultItemCreate {
  const account = labels.account.trim();
  const notes = labels.notes.trim();
  const sites = parseSites(labels.sites);
  const common = {
    service: labels.service.trim(),
    ...(account ? { account } : {}),
    ...(sites.length > 0 ? { sites } : {}),
    ...(notes ? { notes } : {}),
    policy,
  };
  const typed = typedValues(values);
  if (kind === 'secret') return { kind, ...common, value: typed.value };
  return {
    kind,
    ...common,
    ...(typed.username ? { username: typed.username } : {}),
    ...(typed.password ? { password: typed.password } : {}),
    ...(typed.totp ? { totp: typed.totp } : {}),
  };
}

/** What saving an entry sends: the labels that changed and the values typed. */
export function itemChanges(
  item: VaultItem,
  labels: LabelDraft,
  values: ValueDraft = EMPTY_VALUES,
): VaultItemUpdate {
  const body: VaultItemUpdate = {};
  const service = labels.service.trim();
  if (service !== item.service) body.service = service;
  const account = labels.account.trim() || null;
  if (account !== item.account) body.account = account;
  const sites = parseSites(labels.sites);
  if (sitesText(sites) !== sitesText(item.sites)) body.sites = sites;
  const notes = labels.notes.trim() || null;
  if (notes !== item.notes) body.notes = notes;
  const typed = typedValues(values);
  if (item.kind === 'login') {
    if (typed.username) body.username = typed.username;
    if (typed.password) body.password = typed.password;
    if (typed.totp) body.totp = typed.totp;
  } else if (item.kind === 'secret' && typed.value) {
    body.value = typed.value;
  }
  return body;
}

/** Login values that can be removed: any stored one, as long as another stays. */
export function removableFields(item: Pick<VaultItem, 'kind' | 'fields'>): LoginField[] {
  if (item.kind !== 'login' || item.fields.length < 2) return [];
  return LOGIN_FIELDS.filter((field) => item.fields.includes(field));
}

/** What removing a login value sends. */
export function removeFieldBody(field: LoginField): VaultItemUpdate {
  const body: VaultItemUpdate = {};
  body[field] = null;
  return body;
}

// ---------------------------------------------------------------------------------------------
// A bot's request: a login or a secret asked for in its answer, typed straight into the vault

export type { VaultRequestPart } from './activity';

/** The fields a request asks for, in the order the forms show them. */
export function requestFields(part: { fields: readonly VaultField[] }): VaultField[] {
  return FIELD_ORDER.filter((field) => part.fields.includes(field));
}

/** What answering sends: the fields asked for and filled in; null when nothing was typed. */
export function requestValues(
  fields: readonly VaultField[],
  values: ValueDraft,
): Partial<Record<VaultField, string>> | null {
  const typed = typedValues(values);
  const answer: Partial<Record<VaultField, string>> = {};
  for (const field of fields) if (typed[field]) answer[field] = typed[field];
  return Object.keys(answer).length > 0 ? answer : null;
}

export interface RequestInput {
  /** Masked while typed (a toggle shows it). */
  secure: boolean;
  /** What the phone's password manager may fill in. */
  textContentType: 'username' | 'password' | 'oneTimeCode' | 'none';
  autoComplete: 'username' | 'current-password' | 'one-time-code' | 'off';
}

/** How each requested field is typed (an API key or a token is never autofilled). */
export const REQUEST_INPUTS: Record<VaultField, RequestInput> = {
  username: { secure: false, textContentType: 'username', autoComplete: 'username' },
  password: { secure: true, textContentType: 'password', autoComplete: 'current-password' },
  totp: { secure: true, textContentType: 'oneTimeCode', autoComplete: 'one-time-code' },
  value: { secure: true, textContentType: 'none', autoComplete: 'off' },
};

/** Why answering failed: worded under the form, or answered meanwhile (the message refetches). */
export type RequestProblem = 'invalid_totp' | 'empty_answer' | 'answered' | 'failed';

export function requestProblem(error: unknown): RequestProblem {
  const code = problemCode(error);
  if (code === 'invalid_totp' || code === 'empty_answer') return code;
  if (code === 'request_answered') return 'answered';
  return 'failed';
}
