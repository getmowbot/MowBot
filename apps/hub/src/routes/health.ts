import { healthSchema } from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import pkg from '../../package.json' with { type: 'json' };

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        operationId: 'getHealth',
        response: { 200: healthSchema },
      },
    },
    async () => ({ status: 'ok' as const, version: pkg.version, time: new Date().toISOString() }),
  );
};
