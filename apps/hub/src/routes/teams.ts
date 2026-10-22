import {
  teamCreateSchema,
  teamIdParamsSchema,
  teamListSchema,
  teamPlanInputSchema,
  teamPlanResultSchema,
  teamPlanSchema,
  teamSchema,
  teamUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['teams'];

export const teamRoutes: FastifyPluginAsyncZod = async (app) => {
  const { org, runtime, plans } = app.services;

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
          "Deletes a team with its bots (not the main team): they stop, their conversations and dedicated PCs go, the team's PC is removed and its files move to the main team's trash.",
        security: bearerSecurity,
        params: teamIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await runtime.deleteTeam(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    '/teams/:id/messages',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'clearTeamMessages',
        description:
          "Starts every conversation of the team's bots over (see `clearMessages`): for a new project, without the previous one's leftovers. The team's plan goes too; workspace files and tasks are kept.",
        security: bearerSecurity,
        params: teamIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await runtime.clearTeam(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/teams/:id/plan',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getTeamPlan',
        description:
          "The team's plan of attack: its goal, then its steps in order with their owner and status (`plan` null: none yet). Changes come as `plan.updated` events.",
        security: bearerSecurity,
        params: teamIdParamsSchema,
        response: { 200: teamPlanResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      await org.team(request.params.id);
      return { plan: await plans.get(request.params.id) };
    },
  );

  app.put(
    '/teams/:id/plan',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'setTeamPlan',
        description:
          'Writes the plan over. A step with the same title as before keeps what it does not set (owner, status, task); a step that carries a task follows its status.',
        security: bearerSecurity,
        params: teamIdParamsSchema,
        body: teamPlanInputSchema,
        response: { 200: teamPlanSchema, ...errorResponses },
      },
    },
    async (request) => plans.set(request.params.id, request.body, null),
  );

  app.delete(
    '/teams/:id/plan',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'clearTeamPlan',
        description: "Clears the team's plan (its tasks stay).",
        security: bearerSecurity,
        params: teamIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await org.team(request.params.id);
      await plans.clear(request.params.id);
      return reply.code(204).send(null);
    },
  );
};
