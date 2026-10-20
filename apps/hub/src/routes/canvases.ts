import {
  canvasIdParamsSchema,
  canvasListSchema,
  canvasOrderSchema,
  canvasSchema,
  canvasUpdateSchema,
  checklistItemCreateSchema,
  checklistItemParamsSchema,
  checklistItemUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, notFound } from '../http/problems';
import { newItemId, toCanvas } from '../proactivity/canvases';

const tags = ['canvases'];

/** The home page: canvases bots publish, arranged by the user. */
export const canvasRoutes: FastifyPluginAsyncZod = async (app) => {
  const { canvases } = app.services;

  app.get(
    '/canvases',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listCanvases',
        description: 'In the user’s order, hidden ones included (flagged).',
        security: bearerSecurity,
        response: { 200: canvasListSchema, ...errorResponses },
      },
    },
    async () => ({ items: (await canvases.list()).map(toCanvas) }),
  );

  app.patch(
    '/canvases/:id',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'updateCanvas',
        description: 'Size, visibility and folding; the content belongs to the bot.',
        security: bearerSecurity,
        params: canvasIdParamsSchema,
        body: canvasUpdateSchema,
        response: { 200: canvasSchema, ...errorResponses },
      },
    },
    async (request) => canvases.update(request.params.id, request.body),
  );

  app.put(
    '/canvases/order',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'orderCanvases',
        security: bearerSecurity,
        body: canvasOrderSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await canvases.reorder(request.body.ids);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/canvases/:id',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'deleteCanvas',
        security: bearerSecurity,
        params: canvasIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await canvases.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/canvases/:id/items',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'addChecklistItem',
        security: bearerSecurity,
        params: canvasIdParamsSchema,
        body: checklistItemCreateSchema,
        response: { 200: canvasSchema, ...errorResponses },
      },
    },
    async (request) =>
      canvases.editChecklist(request.params.id, (items) => [
        ...items,
        { id: newItemId(), text: request.body.text, done: false },
      ]),
  );

  app.patch(
    '/canvases/:id/items/:itemId',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'updateChecklistItem',
        security: bearerSecurity,
        params: checklistItemParamsSchema,
        body: checklistItemUpdateSchema,
        response: { 200: canvasSchema, ...errorResponses },
      },
    },
    async (request) =>
      canvases.editChecklist(request.params.id, (items) => {
        if (!items.some((item) => item.id === request.params.itemId))
          throw notFound('No such item');
        return items.map((item) =>
          item.id === request.params.itemId ? { ...item, ...request.body } : item,
        );
      }),
  );

  app.delete(
    '/canvases/:id/items/:itemId',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'deleteChecklistItem',
        security: bearerSecurity,
        params: checklistItemParamsSchema,
        response: { 200: canvasSchema, ...errorResponses },
      },
    },
    async (request) =>
      canvases.editChecklist(request.params.id, (items) =>
        items.filter((item) => item.id !== request.params.itemId),
      ),
  );
};
