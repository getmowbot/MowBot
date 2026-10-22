import {
  computerIdParamsSchema,
  computerListSchema,
  computerSchema,
  computerUpdateSchema,
  gpuListSchema,
  ticketSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import WebSocket from 'ws';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const computerAction = (operationId: string, description: string) => ({
  preHandler: requireAuth('control'),
  schema: {
    tags: ['computers'],
    operationId,
    description,
    security: bearerSecurity,
    params: computerIdParamsSchema,
    response: { 200: computerSchema, ...errorResponses },
  },
});

export const computerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { computers, tickets } = app.services;

  app.get(
    '/computers',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['computers'],
        operationId: 'listComputers',
        security: bearerSecurity,
        response: { 200: computerListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await computers.list() }),
  );

  app.get(
    '/computers/gpus',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['computers'],
        operationId: 'listGpus',
        description:
          "The host's graphics cards PCs can get (NVIDIA, through the NVIDIA Container Toolkit). `available` false: none can be handed out.",
        security: bearerSecurity,
        response: { 200: gpuListSchema, ...errorResponses },
      },
    },
    async () => computers.gpus(),
  );

  app.patch(
    '/computers/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags: ['computers'],
        operationId: 'updateComputer',
        description:
          'Changes what the PC runs (`desktop`, or `terminal`: no screen) and the graphics cards it gets. A running PC takes it once it restarts (`restartNeeded`).',
        security: bearerSecurity,
        params: computerIdParamsSchema,
        body: computerUpdateSchema,
        response: { 200: computerSchema, ...errorResponses },
      },
    },
    async (request) => computers.configure(request.params.id, request.body),
  );

  app.get(
    '/computers/:id',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['computers'],
        operationId: 'getComputer',
        security: bearerSecurity,
        params: computerIdParamsSchema,
        response: { 200: computerSchema, ...errorResponses },
      },
    },
    async (request) => computers.get(request.params.id),
  );

  app.post(
    '/computers/:id/start',
    computerAction('startComputer', 'Starts the computer in the background (status `starting`).'),
    async (request) => computers.start(request.params.id),
  );

  app.post(
    '/computers/:id/stop',
    computerAction('stopComputer', 'Stops the container. Files and home directory are kept.'),
    async (request) => computers.stop(request.params.id),
  );

  app.post(
    '/computers/:id/restart',
    computerAction('restartComputer', 'Stops then starts the computer.'),
    async (request) => computers.restart(request.params.id),
  );

  app.post(
    '/computers/:id/takeover',
    computerAction(
      'takeOverComputer',
      "Gives the calling device the mouse and keyboard; bots' input is paused.",
    ),
    async (request) => computers.takeover(request.params.id, authOf(request).deviceId),
  );

  app.delete(
    '/computers/:id/takeover',
    computerAction('releaseComputer', 'Hands the desktop back to the bots.'),
    async (request) => computers.release(request.params.id),
  );

  app.post(
    '/computers/:id/desktop-ticket',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['computers'],
        operationId: 'createDesktopTicket',
        description: 'One-time ticket for `GET /computers/{id}/desktop?ticket=…` (WebSocket, RFB).',
        security: bearerSecurity,
        params: computerIdParamsSchema,
        response: { 200: ticketSchema, ...errorResponses },
      },
    },
    async (request) => {
      await computers.get(request.params.id);
      const auth = authOf(request);
      const { ticket, expiresAt } = tickets.issue({
        kind: 'desktop',
        ownerId: auth.ownerId,
        deviceId: auth.deviceId,
        data: { computerId: request.params.id },
      });
      return { ticket, expiresAt: expiresAt.toISOString() };
    },
  );

  /** RFB over WebSocket, proxied to the computer's mow-agent (which bridges to its VNC server). */
  app.get(
    '/computers/:id/desktop',
    { websocket: true, schema: { hide: true } },
    (socket, request) => {
      const { id } = request.params as { id: string };
      const { ticket } = request.query as { ticket?: string };
      const grant = tickets.consume(ticket, 'desktop');
      if (!grant || grant.data.computerId !== id) {
        socket.close(1008, 'Invalid ticket');
        return;
      }

      let upstream: WebSocket | null = null;
      let opened = false;
      const pending: WebSocket.RawData[] = [];

      // Handlers are attached synchronously so no client frame is lost while the agent connects.
      socket.on('message', (data: WebSocket.RawData) => {
        if (upstream?.readyState === WebSocket.OPEN) upstream.send(data);
        else pending.push(data);
        void computers.touch(id);
      });
      socket.on('close', () => {
        upstream?.close();
        if (opened) computers.desktopClosed(id, grant.deviceId);
      });

      computers
        .agentFor(id)
        .then((agent) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const vnc = agent.openVnc();
          upstream = vnc;
          vnc.on('open', () => {
            opened = true;
            computers.desktopOpened(id, grant.deviceId);
            for (const data of pending.splice(0)) vnc.send(data);
          });
          vnc.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
          vnc.on('close', () => socket.close());
          vnc.on('error', (error) => {
            request.log.warn({ err: error, computerId: id }, 'VNC upstream error');
            socket.close(1011, 'Desktop unavailable');
          });
        })
        .catch(() => socket.close(1011, 'Computer not running'));
    },
  );
};
