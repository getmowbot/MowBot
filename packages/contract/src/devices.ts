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

export const meSchema = z.object({
  owner: z.object({
    id: z.uuid(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
  }),
  device: deviceSchema,
});
export type Me = z.infer<typeof meSchema>;
