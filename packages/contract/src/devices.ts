import { z } from 'zod';
import { deviceKindSchema, scopeSchema } from './auth';

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: deviceKindSchema,
  scopes: z.array(scopeSchema),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceListSchema = z.object({
  items: z.array(deviceSchema),
});
export type DeviceList = z.infer<typeof deviceListSchema>;

export const deviceIdParamsSchema = z.object({
  id: z.uuid(),
});

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
