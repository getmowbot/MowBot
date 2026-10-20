import {
  teamCreateSchema,
  teamIdParamsSchema,
  teamListSchema,
  teamSchema,
  teamUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['teams'];

export const teamRoutes: FastifyPluginAsyncZod = async (app) => {
  const { org } = app.services;

  app.get(
    '/teams',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listTeams',
        security: bearerSecurity,
        response: { 200: teamListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await org.listTeams() }),
  );

  app.post(
    '/teams',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'createTeam',
        description: 'Creates a team with its own workspace and shared PC (started on first use).',
        security: bearerSecurity,
        body: teamCreateSchema,
        response: { 201: teamSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await org.createTeam(request.body)),
  );

  app.patch(
    '/teams/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'updateTeam',
        security: bearerSecurity,
        params: teamIdParamsSchema,
        body: teamUpdateSchema,
        response: { 200: teamSchema, ...errorResponses },
      },
    },
    async (request) => org.updateTeam(request.params.id, request.body),
  );

  app.delete(
    '/teams/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'deleteTeam',
        description:
          "Deletes a team without bots: its PC is removed, its files move to the main team's trash.",
        security: bearerSecurity,
        params: teamIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await org.deleteTeam(request.params.id);
      return reply.code(204).send(null);
    },
  );
};
