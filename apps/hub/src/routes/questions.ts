import {
  questionAnswerSchema,
  questionIdParamsSchema,
  questionListQuerySchema,
  questionListSchema,
  questionSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['questions'];

/** Questions bots ask the user (with answer buttons), shown in the chat and on the home page. */
export const questionRoutes: FastifyPluginAsyncZod = async (app) => {
  const { questions, runtime } = app.services;

  app.get(
    '/questions',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listQuestions',
        description: 'Newest first: the open ones by default.',
        security: bearerSecurity,
        querystring: questionListQuerySchema,
        response: { 200: questionListSchema, ...errorResponses },
      },
    },
    async (request) => ({
      items: await questions.list({
        open: request.query.status === 'open',
        botId: request.query.botId,
      }),
    }),
  );

  app.post(
    '/questions/:id/answer',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'answerQuestion',
        description:
          'Answers with one of the suggested answers or your own words. The bot receives it as a message from you and picks up from there.',
        security: bearerSecurity,
        params: questionIdParamsSchema,
        body: questionAnswerSchema,
        response: { 200: questionSchema, ...errorResponses },
      },
    },
    async (request) => runtime.answerQuestion(request.params.id, request.body.answer),
  );

  app.post(
    '/questions/:id/dismiss',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'dismissQuestion',
        description:
          'Closes the question without answering it: the bot is not told, and waits for what you write next.',
        security: bearerSecurity,
        params: questionIdParamsSchema,
        response: { 200: questionSchema, ...errorResponses },
      },
    },
    async (request) => questions.dismiss(request.params.id),
  );
};
