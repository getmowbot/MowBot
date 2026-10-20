import { ticketSchema } from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const KEEPALIVE_MS = 25_000;

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const { events, tickets } = app.services;

  app.post(
    '/events/ticket',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags: ['events'],
        operationId: 'createEventsTicket',
        description: 'One-time ticket for the `GET /events?ticket=…` WebSocket stream.',
        security: bearerSecurity,
        response: { 200: ticketSchema, ...errorResponses },
      },
    },
    async (request) => {
      const auth = authOf(request);
      const { ticket, expiresAt } = tickets.issue({
        kind: 'events',
        ownerId: auth.ownerId,
        deviceId: auth.deviceId,
        data: {},
      });
      return { ticket, expiresAt: expiresAt.toISOString() };
    },
  );

  /** JSON `ServerEvent` messages, starting with `{ "type": "ready" }`. */
  app.get('/events', { websocket: true, schema: { hide: true } }, (socket, request) => {
    const { ticket } = request.query as { ticket?: string };
    if (!tickets.consume(ticket, 'events')) {
      socket.close(1008, 'Invalid ticket');
      return;
    }
    const unsubscribe = events.subscribe((event) => socket.send(JSON.stringify(event)));
    const keepalive = setInterval(() => socket.ping(), KEEPALIVE_MS);
    socket.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    socket.send(JSON.stringify({ type: 'ready' }));
  });
};
