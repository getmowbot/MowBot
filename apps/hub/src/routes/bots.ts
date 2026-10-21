import {
  botBrowserSchema,
  botCreateSchema,
  botIdParamsSchema,
  botListSchema,
  botMoveSchema,
  botSchema,
  botUpdateSchema,
  messageListQuerySchema,
  messageListSchema,
  messagePressParamsSchema,
  messagePressSchema,
  messageSchema,
  sendMessageSchema,
  vaultRequestAnswerSchema,
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
  const { bots, runtime, providers, db, files, org, routines } = app.services;

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

  app.post(
    '/bots',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'createBot',
        description:
          "Creates a bot in a team (on the team's PC or a dedicated one) or solo (own PC and workspace).",
        security: bearerSecurity,
        body: botCreateSchema,
        response: { 201: botSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (request.body.providerId) await providers.row(request.body.providerId);
      return reply.code(201).send(await org.createBot(request.body));
    },
  );

  app.delete(
    '/bots/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'deleteBot',
        description:
          "Deletes a bot (not the Chef) and its conversation. A dedicated PC goes with it; a solo bot's files move to the main team's trash.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const row = await bots.row(request.params.id);
      if (row.isChef) throw new HttpProblem(409, 'chef', 'The Chef cannot be deleted');
      await runtime.forget(row.id);
      await org.retireBot(row.id);
      return reply.code(204).send(null);
    },
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
        description:
          'Identity, mission, models (main, fallbacks, light model for check-ins), check-in rhythm and daily token budget of a bot.',
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
      for (const ref of [
        ...(body.fallbacks ?? []),
        ...(body.lightModel ? [body.lightModel] : []),
      ]) {
        await providers.row(ref.providerId);
      }
      const updated = await bots.update(request.params.id, body);
      if (body.heartbeatMinutes !== undefined) {
        await routines.syncHeartbeat(await bots.row(request.params.id));
      }
      return updated;
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

  app.post(
    '/bots/:id/messages/:messageId/press',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'pressMessageCard',
        description:
          'Presses a button of a card the bot showed in that message: its reply reaches the bot as your answer (once per card). Buttons that only open a link are opened by the app itself.',
        security: bearerSecurity,
        params: messagePressParamsSchema,
        body: messagePressSchema,
        response: { 200: messageSchema, ...errorResponses },
      },
    },
    async (request) =>
      runtime.pressCard(
        request.params.id,
        request.params.messageId,
        request.body.part,
        request.body.button,
      ),
  );

  app.post(
    '/bots/:id/messages/:messageId/vault-request',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'answerVaultRequest',
        description:
          'Answers a vault request the bot showed in that message: the values go straight into the vault (the bot only learns the reference), or `declined: true`.',
        security: bearerSecurity,
        params: messagePressParamsSchema,
        body: vaultRequestAnswerSchema,
        response: { 200: messageSchema, ...errorResponses },
      },
    },
    async (request) =>
      runtime.answerVaultRequest(request.params.id, request.params.messageId, request.body),
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

  app.post(
    '/bots/:id/move',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'moveBot',
        description:
          "Moves a bot to another team (teamId null: solo), on the team's PC or a dedicated one. The bot stops, tidies its old computer up, and its folder follows it to the new workspace. Not the Chef.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: botMoveSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => runtime.moveBot(request.params.id, request.body),
  );

  app.get(
    '/bots/:id/browser',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getBotBrowser',
        description:
          "What the bot's own Chrome window shows now (a JPEG capture), for a live view. Poll it.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: botBrowserSchema, ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      return runtime.browser.view(request.params.id);
    },
  );

  app.post(
    '/bots/:id/browser/front',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'showBotBrowser',
        description:
          "Puts the bot's Chrome window in front on its computer's screen, e.g. before taking over.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await bots.row(request.params.id);
      if (!(await runtime.browser.front(request.params.id))) {
        throw new HttpProblem(409, 'no_page', 'This bot has no page open.');
      }
      return reply.code(204).send(null);
    },
  );
};
