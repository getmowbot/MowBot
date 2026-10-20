import {
  botIdParamsSchema,
  botListSchema,
  botSchema,
  botUpdateSchema,
  messageListQuerySchema,
  messageListSchema,
  messageSchema,
  sendMessageSchema,
} from '@mowbot/contract';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { toBot, toMessage } from '../bots/service';
import { messages } from '../db/schema';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, HttpProblem } from '../http/problems';

const tags = ['bots'];

export const botRoutes: FastifyPluginAsyncZod = async (app) => {
  const { bots, runtime, providers, db, files } = app.services;

  app.get(
    '/bots',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listBots',
        security: bearerSecurity,
        response: { 200: botListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await bots.list() }),
  );

  app.get(
    '/bots/:id',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getBot',
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => toBot(await bots.row(request.params.id)),
  );

  app.patch(
    '/bots/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'updateBot',
        description: 'Identity, mission, provider and model of a bot.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: botUpdateSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await bots.row(request.params.id);
      const body = request.body;
      if (body.name && body.name !== row.name) await bots.moveFolder(row, body.name, files);
      if (body.providerId) {
        const provider = await providers.row(body.providerId);
        // Switching provider without naming a model: take the provider's default.
        if (body.model === undefined) body.model = provider.defaultModel;
      }
      return bots.update(request.params.id, body);
    },
  );

  app.get(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listMessages',
        description: 'Conversation with the bot, newest page first (items are oldest → newest).',
        security: bearerSecurity,
        params: botIdParamsSchema,
        querystring: messageListQuerySchema,
        response: { 200: messageListSchema, ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      const { before, limit } = request.query;
      let cursor: Date | null = null;
      if (before) {
        cursor = new Date(before);
        if (Number.isNaN(cursor.getTime()))
          throw new HttpProblem(400, 'invalid_cursor', 'Bad cursor');
      }
      const rows = await db
        .select()
        .from(messages)
        .where(
          cursor
            ? and(eq(messages.botId, request.params.id), lt(messages.createdAt, cursor))
            : eq(messages.botId, request.params.id),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).reverse();
      const oldest = page[0];
      return {
        items: page.map(toMessage),
        nextCursor: rows.length > limit && oldest ? oldest.createdAt.toISOString() : null,
      };
    },
  );

  app.post(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'sendMessage',
        description:
          'Posts a message to the bot. Its answer streams through `message.delta` / `message.updated` events.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: sendMessageSchema,
        response: { 202: messageSchema, ...errorResponses },
      },
    },
    async (request, reply) =>
      reply.code(202).send(await runtime.send(request.params.id, request.body.text)),
  );

  app.delete(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'clearMessages',
        description:
          'Starts the conversation over: stops the bot, deletes its messages and closes what it left open on its computer. Workspace files are kept.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await runtime.clear(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/bots/:id/stop',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'stopBot',
        description: "Interrupts the bot's current run.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: z.object({ stopped: z.boolean() }), ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      return { stopped: runtime.stop(request.params.id) };
    },
  );
};
