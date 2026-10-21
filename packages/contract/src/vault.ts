import { z } from 'zod';

/**
 * `session`: a site's cookies and local storage, captured from a computer's Chrome and loaded
 * into another's; `login`: username, password and 2FA seed; `secret`: a single value (API key…).
 */
export const vaultKindSchema = z.enum(['session', 'login', 'secret']);
export type VaultKind = z.infer<typeof vaultKindSchema>;

/** `auto`: any bot may use it; `ask`: the user approves each bot once (a question with buttons). */
export const vaultPolicySchema = z.enum(['auto', 'ask']);
export type VaultPolicy = z.infer<typeof vaultPolicySchema>;

/** Stored values of a login or secret, never sent back by the API. */
export const vaultFieldSchema = z.enum(['username', 'password', 'totp', 'value']);
export type VaultField = z.infer<typeof vaultFieldSchema>;

/** A vault entry, without its values (they never leave the hub). */
export const vaultItemSchema = z.object({
  id: z.uuid(),
  /** Short reference bots use in placeholders: `{{vault:<ref>.password}}`. */
  ref: z.string(),
  kind: vaultKindSchema,
  /** What it opens, e.g. "Google". */
  service: z.string(),
  /** Which account, e.g. "joris@gmail.com". */
  account: z.string().nullable(),
  /** Sites it is for (registrable domains, e.g. "google.com"). */
  sites: z.array(z.string()),
  notes: z.string().nullable(),
  policy: vaultPolicySchema,
  /** Values stored (login and secret). */
  fields: z.array(vaultFieldSchema),
  /** Session: the computer whose Chrome it comes from (null once that computer is gone). */
  computerId: z.uuid().nullable(),
  /** The bot that saved it (null: the user, or the end of a takeover). */
  createdByBotId: z.uuid().nullable(),
  /** Session: what was captured. */
  session: z.object({ cookies: z.number().int(), origins: z.number().int() }).nullable(),
  /** Bots the user allowed to use an `ask` item. */
  grantedBotIds: z.array(z.uuid()),
  capturedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type VaultItem = z.infer<typeof vaultItemSchema>;

export const vaultItemListSchema = z.object({ items: z.array(vaultItemSchema) });

export const vaultItemIdParamsSchema = z.object({ id: z.uuid() });

export const vaultGrantParamsSchema = z.object({ id: z.uuid(), botId: z.uuid() });

const labelsSchema = {
  service: z.string().trim().min(1).max(100),
  account: z.string().trim().max(200).nullable().optional(),
  sites: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  policy: vaultPolicySchema.optional(),
};

/** A secret value: entered in a masked field, write-only. */
const valueSchema = z.string().min(1).max(10_000);

/** A 2FA seed, base32 or an `otpauth://` link. */
const totpSchema = z.string().trim().min(1).max(500);

export const vaultItemCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login'),
    ...labelsSchema,
    username: z.string().max(500).optional(),
    password: valueSchema.optional(),
    totp: totpSchema.optional(),
  }),
  z.object({ kind: z.literal('secret'), ...labelsSchema, value: valueSchema }),
]);
export type VaultItemCreate = z.infer<typeof vaultItemCreateSchema>;

/** Labels and policy; values are replaced when given, removed when null. */
export const vaultItemUpdateSchema = z.object({
  service: labelsSchema.service.optional(),
  account: labelsSchema.account,
  sites: labelsSchema.sites,
  notes: labelsSchema.notes,
  policy: labelsSchema.policy,
  username: z.string().max(500).nullable().optional(),
  password: valueSchema.nullable().optional(),
  totp: totpSchema.nullable().optional(),
  value: valueSchema.optional(),
});
export type VaultItemUpdate = z.infer<typeof vaultItemUpdateSchema>;

/** Saves (or refreshes) the session of a site from a running computer's Chrome. */
export const vaultSessionCaptureSchema = z.object({
  computerId: z.uuid(),
  /** A domain or an address of the site, e.g. "accounts.google.com". */
  site: z.string().trim().min(1).max(2_000),
  service: z.string().trim().min(1).max(100).optional(),
  account: z.string().trim().max(200).nullable().optional(),
});
export type VaultSessionCapture = z.infer<typeof vaultSessionCaptureSchema>;

/** A site with cookies in a computer's Chrome, to pick the session to save. */
export const computerSiteSchema = z.object({
  site: z.string(),
  cookies: z.number().int(),
  /** A vault session of this computer already holds it. */
  itemId: z.uuid().nullable(),
});
export const computerSiteListSchema = z.object({ items: z.array(computerSiteSchema) });

export const vaultActionSchema = z.enum([
  'created',
  'updated',
  'captured',
  'used',
  'requested',
  'granted',
  'denied',
  'revoked',
]);
export type VaultAction = z.infer<typeof vaultActionSchema>;

/** One line of an item's history: who did what, from which computer. */
export const vaultEventSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  action: vaultActionSchema,
  /** The bot involved (null: the user or the hub). */
  botId: z.uuid().nullable(),
  computerId: z.uuid().nullable(),
  /**
   * A code the apps word: `takeover_end` (captured when the user handed a PC back),
   * `refreshed` (re-read from its PC before use), `values_replaced`; on `used`, the field
   * (`username`, `password`, `totp`, `value`).
   */
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type VaultEvent = z.infer<typeof vaultEventSchema>;

export const vaultEventListSchema = z.object({ items: z.array(vaultEventSchema) });
