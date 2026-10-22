import {
  automationIdParamsSchema,
  automationListSchema,
  automationSchema,
  automationUpdateSchema,
  notificationListSchema,
  notificationReadSchema,
  routineCreateSchema,
  routineIdParamsSchema,
  routineListQuerySchema,
  routineListSchema,
  routineRunListSchema,
  routineRunReasonSchema,
  routineRunStatusSchema,
  routineSchema,
  routineUpdateSchema,
  systemSettingsSchema,
  systemSettingsUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, HttpProblem, notFound } from '../http/problems';
import { toAutomation } from '../proactivity/automations';
import { SHOWN_KINDS } from '../proactivity/routines';

/** A webhook may fire its routine at most this often. */
const WEBHOOK_MIN_GAP_MS = 10_000;

/** Routines (and their runs), notifications, the proactivity settings and webhooks. */
export const proactivityRoutes: FastifyPluginAsyncZod = async (app) => {
  const { routines, notifications, system, scheduler, runtime, bots } = app.services;
  const lastWebhook = new Map<string, number>();

  app.get(
    '/routines',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['routines'],
        operationId: 'listRoutines',
        security: bearerSecurity,
        querystring: routineListQuerySchema,
        response: { 200: routineListSchema, ...errorResponses },
      },
    },
    // The bots' initiatives and the watch are not the user's routines (see /initiatives).
    async (request) => ({
      items: (await routines.list(request.query.botId))
        .filter((row) => SHOWN_KINDS.includes(row.kind))
        .map((row) => routines.toRoutine(row)),
    }),
  );

  app.post(
    '/routines',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags: ['routines'],
        operationId: 'createRoutine',
        security: bearerSecurity,
        body: routineCreateSchema,
        response: { 201: routineSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      await bots.row(request.body.botId);
      return reply.code(201).send(await routines.create(request.body, 'user'));
    },
  );

  app.patch(
    '/routines/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags: ['routines'],
        operationId: 'updateRoutine',
        security: bearerSecurity,
        params: routineIdParamsSchema,
        body: routineUpdateSchema,
        response: { 200: routineSchema, ...errorResponses },
      },
    },
    async (request) => routines.update(request.params.id, request.body),
  );

  app.delete(
    '/routines/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags: ['routines'],
        operationId: 'deleteRoutine',
        description: 'Check-ins are stopped from the bot (heartbeatMinutes: null).',
        security: bearerSecurity,
        params: routineIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const routine = await routines.row(request.params.id);
      if (routine.kind === 'heartbeat') {
        throw new HttpProblem(409, 'heartbeat', "Set the bot's heartbeatMinutes to null instead");
      }
      await routines.remove(routine.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/routines/:id/run',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['routines'],
        operationId: 'runRoutine',
        description: 'Fires the routine now, even when paused, over budget or in quiet hours.',
        security: bearerSecurity,
        params: routineIdParamsSchema,
        response: {
          202: z.object({
            status: routineRunStatusSchema,
            reason: routineRunReasonSchema.nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(await scheduler.fire(await routines.row(request.params.id), { manual: true })),
  );

  app.get(
    '/routines/:id/runs',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['routines'],
        operationId: 'listRoutineRuns',
        description: 'The last 20 runs, newest first.',
        security: bearerSecurity,
        params: routineIdParamsSchema,
        response: { 200: routineRunListSchema, ...errorResponses },
      },
    },
    async (request) => {
      await routines.row(request.params.id);
      return { items: await routines.runs(request.params.id) };
    },
  );

  app.post(
    '/hooks/routines/:id/:token',
    {
      // Called by outside services: the secret in the URL is the credential.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['routines'],
        operationId: 'callRoutineWebhook',
        description:
          'Fires a webhook routine; the request body (JSON or text, 8 KB kept) is handed to the bot as data.',
        params: z.object({ id: z.uuid(), token: z.string().min(1).max(200) }),
        response: { 202: z.object({ accepted: z.boolean() }), ...errorResponses },
      },
    },
    async (request, reply) => {
      const routine = await routines.verifyWebhook(request.params.id, request.params.token);
      if (!routine) throw notFound('Unknown webhook');
      const now = Date.now();
      if (!routine.enabled || now - (lastWebhook.get(routine.id) ?? 0) < WEBHOOK_MIN_GAP_MS) {
        return reply.code(202).send({ accepted: false });
      }
      lastWebhook.set(routine.id, now);
      const body = request.body;
      const payload =
        body === undefined || body === null
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body, null, 2);
      const { status } = await scheduler.fire(routine, { payload });
      return reply.code(202).send({ accepted: status === 'running' });
    },
  );

  app.get(
    '/notifications',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['notifications'],
        operationId: 'listNotifications',
        description: 'The latest 100, newest first; `unread` leaves out digest-level ones.',
        security: bearerSecurity,
        response: { 200: notificationListSchema, ...errorResponses },
      },
    },
    async () => notifications.list(),
  );

  app.delete(
    '/notifications',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['notifications'],
        operationId: 'clearNotifications',
        description: 'Deletes every notification.',
        security: bearerSecurity,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (_request, reply) => {
      await notifications.clear();
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/notifications/read',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['notifications'],
        operationId: 'readNotifications',
        security: bearerSecurity,
        body: notificationReadSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await notifications.markRead(request.body.ids, request.body.botId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/system',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['system'],
        operationId: 'getSystemSettings',
        security: bearerSecurity,
        response: { 200: systemSettingsSchema, ...errorResponses },
      },
    },
    async () => system.get(),
  );

  app.patch(
    '/system',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags: ['system'],
        operationId: 'updateSystemSettings',
        description:
          'Pausing stops every bot at once; bots then only answer the user until resumed.',
        security: bearerSecurity,
        body: systemSettingsUpdateSchema,
        response: { 200: systemSettingsSchema, ...errorResponses },
      },
    },
    async (request) => {
      const before = await system.get();
      const settings = await system.update(request.body);
      if (settings.paused && !before.paused) runtime.pauseAll();
      if (!settings.paused && before.paused) await runtime.resumeAll();
      if (settings.watch !== before.watch) {
        const chef = await bots.chef();
        if (chef) await routines.syncWatch(chef, settings.watch);
      }
      return settings;
    },
  );

  app.get(
    '/automations',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['routines'],
        operationId: 'listAutomations',
        description:
          "Bots' scripts the hub runs on their computers at a steady pace (no model involved): active, paused, and those stopped in the last day.",
        security: bearerSecurity,
        response: { 200: automationListSchema, ...errorResponses },
      },
    },
    async () => ({ items: (await app.services.automations.list()).map(toAutomation) }),
  );

  app.patch(
    '/automations/:id',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['routines'],
        operationId: 'updateAutomation',
        description: 'Pauses or resumes an automation.',
        security: bearerSecurity,
        params: automationIdParamsSchema,
        body: automationUpdateSchema,
        response: { 200: automationSchema, ...errorResponses },
      },
    },
    async (request) => {
      await app.services.automations.row(request.params.id);
      return toAutomation(
        await app.services.automations.update(request.params.id, { status: request.body.status }),
      );
    },
  );

  app.delete(
    '/automations/:id',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['routines'],
        operationId: 'deleteAutomation',
        description: 'Stops and deletes an automation.',
        security: bearerSecurity,
        params: automationIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await app.services.automations.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );
};
