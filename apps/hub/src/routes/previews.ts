import { previewIdParamsSchema, previewListQuerySchema, previewListSchema } from '@mowbot/contract';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';
import type { LinkBase } from '../previews/service';

const tags = ['previews'];

/** Links for the address this client reaches the hub at (domain, LAN IP, localhost…). */
const baseOf = (request: FastifyRequest): LinkBase => ({
  protocol: request.protocol === 'https' ? 'https' : 'http',
  hostname: request.hostname,
});

/** Web pages the bots shared from their PCs. Only the owner sees them. */
export const previewRoutes: FastifyPluginAsyncZod = async (app) => {
  const { previews } = app.services;

  app.get(
    '/previews',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listPreviews',
        description:
          'Running previews (of one PC with `computerId`), with their links for the address of this request.',
        security: bearerSecurity,
        querystring: previewListQuerySchema,
        response: { 200: previewListSchema, ...errorResponses },
      },
    },
    async (request) => ({
      items: (await previews.list(request.query.computerId)).map((row) =>
        previews.toPreview(row, baseOf(request)),
      ),
    }),
  );

  app.delete(
    '/previews/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'stopPreview',
        description: 'Stops the preview: its link and the cookies it gave stop working.',
        security: bearerSecurity,
        params: previewIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await previews.stop(request.params.id);
      return reply.code(204).send(null);
    },
  );
};
