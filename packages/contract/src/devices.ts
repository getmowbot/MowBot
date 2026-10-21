import { z } from 'zod';
import { deviceKindSchema, scopeSchema } from './auth';

/** What a phone is told about (each can be turned off), and whether bots' words show. */
export const pushPrefsSchema = z.object({
  /** A bot finished something the user asked for. */
  finished: z.boolean(),
  /** A bot needs the user: a question, a login to enter… */
  needsYou: z.boolean(),
  /** What bots notify (urgent and normal ones; digests wait for the daily summary). */
  notifications: z.boolean(),
  /** Only "Chef a fini", "Chef a besoin de toi": no text from the bots. */
  hideContent: z.boolean(),
});
export type PushPrefs = z.infer<typeof pushPrefsSchema>;

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  finished: true,
  needsYou: true,
  notifications: true,
  hideContent: false,
};

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: deviceKindSchema,
  scopes: z.array(scopeSchema),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  current: z.boolean(),
  /** Push notifications: whether this device registered for them, and what it wants. */
  push: z.object({ enabled: z.boolean(), prefs: pushPrefsSchema }),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceListSchema = z.object({
  items: z.array(deviceSchema),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

export const deviceIdParamsSchema = z.object({
  id: z.uuid(),
});

/**
 * The current device's push notifications: its Expo push token (null turns them off) and its
 * preferences.
 */
export const devicePushSchema = z.object({
  token: z
    .string()
    .regex(/^(Exponent|Expo)PushToken\[[^\]]+\]$/)
    .max(300)
    .nullable()
    .optional(),
  prefs: pushPrefsSchema.partial().optional(),
});
export type DevicePush = z.infer<typeof devicePushSchema>;

/** Languages of the apps; bots answer the owner in theirs. */
export const localeSchema = z.enum(['fr', 'en']);
export type Locale = z.infer<typeof localeSchema>;

export const meSchema = z.object({
  owner: z.object({
    id: z.uuid(),
    displayName: z.string(),
    locale: localeSchema,
    createdAt: z.iso.datetime(),
  }),
  device: deviceSchema,
});
export type Me = z.infer<typeof meSchema>;

export const meUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  locale: localeSchema.optional(),
});
export type MeUpdate = z.infer<typeof meUpdateSchema>;
