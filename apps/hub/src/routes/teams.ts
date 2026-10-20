import { type Team, teamListSchema } from '@mowbot/contract';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { computers, teams } from '../db/schema';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

export const teamRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app.services;

  app.get(
    '/teams',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['teams'],
        operationId: 'listTeams',
        security: bearerSecurity,
        response: { 200: teamListSchema, ...errorResponses },
      },
    },
    async () => {
      const rows = await db
        .select({ team: teams, computerId: computers.id })
        .from(teams)
        .leftJoin(computers, and(eq(computers.teamId, teams.id), eq(computers.kind, 'team')))
        .orderBy(teams.createdAt);
      const items: Team[] = rows.map(({ team, computerId }) => ({
        id: team.id,
        name: team.name,
        mission: team.mission,
        isMain: team.isMain,
        isolated: team.isolated,
        workspaceId: team.workspaceId,
        computerId,
        createdAt: team.createdAt.toISOString(),
      }));
      return { items };
    },
  );
};
