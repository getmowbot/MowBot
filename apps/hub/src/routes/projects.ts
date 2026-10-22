import {
  connectorCreatedSchema,
  connectorCreateSchema,
  connectorIdParamsSchema,
  connectorListSchema,
  connectorPickedSchema,
  connectorPickSchema,
  mirrorConflictsDismissSchema,
  projectIdParamsSchema,
  projectListSchema,
  projectSchema,
  projectUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ConnectorRow } from '../connectors/service';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, unauthorized } from '../http/problems';

const tags = ['projects'];

/** The desktop apps of the user's computers, and the folders shared there for the bots. */
export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const { connectors, mirrors, runtime } = app.services;
  /** The connector behind each WebSocket, known before the upgrade. */
  const authenticated = new WeakMap<object, ConnectorRow>();

  app.post(
    '/connectors',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'createConnector',
        description:
          'Links a desktop app: the token, shown only here, lets it connect to `GET /connectors/ws`.',
        security: bearerSecurity,
        body: connectorCreateSchema,
        response: { 201: connectorCreatedSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await connectors.create(request.body)),
  );

  app.get(
    '/connectors',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listConnectors',
        security: bearerSecurity,
        response: { 200: connectorListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await connectors.list() }),
  );

  app.delete(
    '/connectors/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'deleteConnector',
        description: 'Unlinks a computer: its token stops working and its projects go.',
        security: bearerSecurity,
        params: connectorIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await connectors.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  // The desktop app's connection (docs/DESKTOP.md), with its own token.
  app.get(
    '/connectors/ws',
    {
      websocket: true,
      schema: { hide: true },
      preHandler: async (request) => {
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
        const row = token ? await connectors.authenticate(token) : null;
        if (!row) throw unauthorized();
        authenticated.set(request, row);
      },
    },
    (socket, request) => {
      const row = authenticated.get(request);
      if (!row) {
        socket.close(1008, 'Unauthorized');
        return;
      }
      connectors.attach(row, socket);
    },
  );

  app.get(
    '/projects',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listProjects',
        security: bearerSecurity,
        response: { 200: projectListSchema, ...errorResponses },
      },
    },
    async () => ({ items: (await connectors.projects()).map((row) => connectors.toProject(row)) }),
  );

  app.patch(
    '/projects/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'updateProject',
        description:
          'Who may work in the project and how: `ask` (each command approved) or `auto`. Folders are shared from the desktop app.',
        security: bearerSecurity,
        params: projectIdParamsSchema,
        body: projectUpdateSchema,
        response: { 200: projectSchema, ...errorResponses },
      },
    },
    async (request) => {
      const before = await connectors.project(request.params.id);
      const row = await connectors.updateProject(request.params.id, request.body);
      if (row.mirror !== before.mirror) await mirrors.setEnabled(row);
      return connectors.toProject(row);
    },
  );

  app.post(
    '/projects/:id/conflicts/dismiss',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'dismissMirrorConflicts',
        description:
          "Clears a mirror's conflicts (or one file's): the bots' versions kept aside go to the workspace's trash.",
        security: bearerSecurity,
        params: projectIdParamsSchema,
        body: mirrorConflictsDismissSchema,
        response: { 200: projectSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await connectors.project(request.params.id);
      await mirrors.dismissConflicts(row.id, request.body.workspaceId, request.body.path);
      return connectors.toProject(row);
    },
  );

  app.post(
    '/connectors/:id/pick',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'pickConnectorFolder',
        description:
          "Opens the folder picker on that computer (its desktop app, 0.2.5+): the folder the user picks there is shared, and becomes the bot's active project. Waits up to 5 minutes; `project` is null when they cancel.",
        security: bearerSecurity,
        params: connectorIdParamsSchema,
        body: connectorPickSchema,
        response: { 200: connectorPickedSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await connectors.pick(request.params.id);
      if (row && request.body.botId) await runtime.setProject(request.body.botId, row.id);
      return { project: row ? connectors.toProject(row) : null };
    },
  );
};
