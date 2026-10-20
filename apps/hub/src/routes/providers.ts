import {
  modelListSchema,
  providerCreateSchema,
  providerIdParamsSchema,
  providerListSchema,
  providerSchema,
  providerUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit } from '../audit';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['providers'];

export const providerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { providers, db } = app.services;

  app.get(
    '/providers',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listProviders',
        security: bearerSecurity,
        response: { 200: providerListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await providers.list() }),
  );

  app.post(
    '/providers',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'createProvider',
        description:
          'Adds an LLM endpoint. The API key is sealed at rest and never returned. The first provider is assigned to the bots without one.',
        security: bearerSecurity,
        body: providerCreateSchema,
        response: { 201: providerSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const provider = await providers.create(request.body);
      await recordAudit(db, {
        actorType: 'device',
        actorId: authOf(request).deviceId,
        action: 'provider.create',
        data: { providerId: provider.id, kind: provider.kind },
      });
      return reply.code(201).send(provider);
    },
  );

  app.patch(
    '/providers/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'updateProvider',
        security: bearerSecurity,
        params: providerIdParamsSchema,
        body: providerUpdateSchema,
        response: { 200: providerSchema, ...errorResponses },
      },
    },
    async (request) => providers.update(request.params.id, request.body),
  );

  app.delete(
    '/providers/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'deleteProvider',
        security: bearerSecurity,
        params: providerIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await providers.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/providers/:id/models',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listProviderModels',
        description: 'Models advertised by the endpoint. Doubles as a connection test.',
        security: bearerSecurity,
        params: providerIdParamsSchema,
        response: { 200: modelListSchema, ...errorResponses },
      },
    },
    async (request) => ({ items: await providers.listModels(request.params.id) }),
  );
};
