import {
  feedSchema,
  messageListQuerySchema,
  taskCreateSchema,
  taskIdParamsSchema,
  taskListQuerySchema,
  taskListSchema,
  taskSchema,
  taskUpdateSchema,
} from '@mowbot/contract';
import { and, desc, isNotNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { toMessage } from '../bots/service';
import { messages } from '../db/schema';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, HttpProblem } from '../http/problems';

/** Tasks between bots (the user can give and move them too) and the feed of bot-to-bot messages. */
export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  const { tasks, bots, db } = app.services;

  app.get(
    '/tasks',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['tasks'],
        operationId: 'listTasks',
        description: 'Most recently updated first (200 at most).',
        security: bearerSecurity,
        querystring: taskListQuerySchema,
        response: { 200: taskListSchema, ...errorResponses },
      },
    },
    async (request) => ({ items: await tasks.list(request.query) }),
  );

  app.post(
    '/tasks',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['tasks'],
        operationId: 'createTask',
        description: 'Gives a task to a bot, which is woken up to do it.',
        security: bearerSecurity,
        body: taskCreateSchema,
        response: { 201: taskSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const assignee = await bots.row(request.body.assigneeBotId);
      const task = await tasks.create(
        { assignee, title: request.body.title, details: request.body.details },
        null,
      );
      return reply.code(201).send(task);
    },
  );

  app.patch(
    '/tasks/:id',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags: ['tasks'],
        operationId: 'updateTask',
        description: 'A status change is reported to the bot doing the task.',
        security: bearerSecurity,
        params: taskIdParamsSchema,
        body: taskUpdateSchema,
        response: { 200: taskSchema, ...errorResponses },
      },
    },
    async (request) => tasks.update(request.params.id, request.body, null),
  );

  app.get(
    '/feed',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['bots'],
        operationId: 'listFeed',
        description: 'What bots write to each other, newest page first (items oldest → newest).',
        security: bearerSecurity,
        querystring: messageListQuerySchema,
        response: { 200: feedSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { before, limit } = request.query;
      const cursor = before ? new Date(before) : null;
      if (cursor && Number.isNaN(cursor.getTime())) {
        throw new HttpProblem(400, 'invalid_cursor', 'Bad cursor');
      }
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(isNotNull(messages.fromBotId), cursor ? lt(messages.createdAt, cursor) : undefined),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).reverse();
      const oldest = page[0];
      return {
        items: page.map((row) => ({ ...toMessage(row), toBotId: row.botId })),
        nextCursor: rows.length > limit && oldest ? oldest.createdAt.toISOString() : null,
      };
    },
  );
};
