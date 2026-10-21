import {
  DEFAULT_PUSH_PREFS,
  type Device,
  deviceIdParamsSchema,
  deviceListSchema,
  devicePushSchema,
  meSchema,
  meUpdateSchema,
} from '@mowbot/contract';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit } from '../audit';
import type { DeviceRow } from '../auth/sessions';
import { devices, owner } from '../db/schema';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, notFound } from '../http/problems';

const toDevice = (row: DeviceRow, currentDeviceId: string): Device => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  scopes: row.scopes,
  createdAt: row.createdAt.toISOString(),
  lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  current: row.id === currentDeviceId,
  push: {
    enabled: Boolean(row.pushToken),
    prefs: { ...DEFAULT_PUSH_PREFS, ...row.pushPrefs },
  },
});

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, sessions } = app.services;

  const loadMe = async (deviceId: string) => {
    const [row] = await db
      .select({ owner, device: devices })
      .from(devices)
      .innerJoin(owner, eq(devices.ownerId, owner.id))
      .where(eq(devices.id, deviceId));
    if (!row) throw notFound('Device not found');
    return {
      owner: {
        id: row.owner.id,
        displayName: row.owner.displayName,
        locale: row.owner.locale,
        createdAt: row.owner.createdAt.toISOString(),
      },
      device: toDevice(row.device, deviceId),
    };
  };

  app.get(
    '/me',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['account'],
        operationId: 'getMe',
        security: bearerSecurity,
        response: { 200: meSchema, ...errorResponses },
      },
    },
    async (request) => loadMe(authOf(request).deviceId),
  );

  app.patch(
    '/me',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['account'],
        operationId: 'updateMe',
        description: 'Name and language of the owner (bots answer in that language).',
        security: bearerSecurity,
        body: meUpdateSchema,
        response: { 200: meSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { displayName, locale } = request.body;
      await db.update(owner).set({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(locale !== undefined ? { locale } : {}),
        updatedAt: new Date(),
      });
      return loadMe(authOf(request).deviceId);
    },
  );

  app.put(
    '/me/push',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['account'],
        operationId: 'updateMyPush',
        description:
          "This device's push notifications: its Expo push token (null turns them off) and what it wants to hear about.",
        security: bearerSecurity,
        body: devicePushSchema,
        response: { 200: meSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { deviceId } = authOf(request);
      const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
      if (!row) throw notFound('Device not found');
      const { token, prefs } = request.body;
      // One phone, one device: an older session of it (signed out offline…) stops getting pushes.
      if (token) {
        await db
          .update(devices)
          .set({ pushToken: null })
          .where(and(eq(devices.pushToken, token), ne(devices.id, deviceId)));
      }
      await db
        .update(devices)
        .set({
          ...(token !== undefined ? { pushToken: token } : {}),
          ...(prefs ? { pushPrefs: { ...DEFAULT_PUSH_PREFS, ...row.pushPrefs, ...prefs } } : {}),
        })
        .where(eq(devices.id, deviceId));
      return loadMe(deviceId);
    },
  );

  app.get(
    '/devices',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['account'],
        operationId: 'listDevices',
        security: bearerSecurity,
        response: { 200: deviceListSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = authOf(request);
      const rows = await db
        .select()
        .from(devices)
        .where(eq(devices.ownerId, auth.ownerId))
        .orderBy(desc(devices.createdAt));
      return { items: rows.map((row) => toDevice(row, auth.deviceId)) };
    },
  );

  app.delete(
    '/devices/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags: ['account'],
        operationId: 'revokeDevice',
        security: bearerSecurity,
        params: deviceIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const [target] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.id, request.params.id), eq(devices.ownerId, auth.ownerId)));
      if (!target) throw notFound('Device not found');
      await sessions.revokeDevice(target.id);
      await recordAudit(db, {
        actorType: 'device',
        actorId: auth.deviceId,
        action: 'device.revoke',
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        data: { deviceId: target.id },
      });
      return reply.code(204).send(null);
    },
  );
};
