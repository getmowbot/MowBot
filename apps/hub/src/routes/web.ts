import { webSearchSettingsSchema, webSearchUpdateSchema } from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['web'];

/** Where the bots' web searches go (they search from the hub, without their computer). */
export const webRoutes: FastifyPluginAsyncZod = async (app) => {
  const { web } = app.services;

  app.get(
    '/settings/web-search',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getWebSearchSettings',
        security: bearerSecurity,
        response: { 200: webSearchSettingsSchema, ...errorResponses },
      },
    },
    async () => web.settings(),
  );

  app.put(
    '/settings/web-search',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'updateWebSearchSettings',
        description:
          'Picks the search the bots use: DuckDuckGo (free, no key), or Brave Search or Tavily with an API key. The key is sealed and never comes back.',
        security: bearerSecurity,
        body: webSearchUpdateSchema,
        response: { 200: webSearchSettingsSchema, ...errorResponses },
      },
    },
    async (request) => web.configure(request.body),
  );
};
