import {
  initiativeListSchema,
  memoryCreateSchema,
  memoryIdParamsSchema,
  memoryListSchema,
  memorySchema,
  memoryUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, notFound } from '../http/problems';
import type { RoutineRow } from '../proactivity/routines';

const tags = ['memory'];

const toInitiative = (row: RoutineRow) => ({
  id: row.id,
  botId: row.botId,
  what: row.prompt,
  at: (row.nextRunAt ?? row.createdAt).toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/** What the bots know about the user (the user sees, fixes, deletes), and what they planned. */
export const memoryRoutes: FastifyPluginAsyncZod = async (app) => {
  const { memory, routines } = app.services;

  app.get(
    '/memories',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listMemories',
        description:
          'What the bots know about the user, whichever heard it: who they are, what they like and use, what is coming. Newest first.',
        security: bearerSecurity,
        response: { 200: memoryListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await memory.list() }),
  );

  app.post(
    '/memories',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'createMemory',
        description: 'Tells every bot something about yourself.',
        security: bearerSecurity,
        body: memoryCreateSchema,
        response: { 201: memorySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { memory: kept } = await memory.remember(request.body, null);
      return reply.code(201).send(kept);
    },
  );

  app.patch(
    '/memories/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'updateMemory',
        security: bearerSecurity,
        params: memoryIdParamsSchema,
        body: memoryUpdateSchema,
        response: { 200: memorySchema, ...errorResponses },
      },
    },
    async (request) => memory.update(request.params.id, request.body),
  );

  app.delete(
    '/memories/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'deleteMemory',
        description: 'Every bot forgets it.',
        security: bearerSecurity,
        params: memoryIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await memory.forget(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/initiatives',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listInitiatives',
        description:
          'What the bots planned to do for the user on their own, still to come, soonest first (not among the routines).',
        security: bearerSecurity,
        response: { 200: initiativeListSchema, ...errorResponses },
      },
    },
    async () => ({ items: (await routines.initiatives()).map(toInitiative) }),
  );

  app.delete(
    '/initiatives/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'cancelInitiative',
        security: bearerSecurity,
        params: memoryIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const row = await routines.row(request.params.id);
      if (row.kind !== 'initiative') throw notFound('Initiative not found');
      await routines.remove(row.id);
      return reply.code(204).send(null);
    },
  );
};
