import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import pkg from '../package.json' with { type: 'json' };
import { HttpProblem, problemBody } from './http/problems';
import { authRoutes } from './routes/auth';
import { botRoutes } from './routes/bots';
import { computerRoutes } from './routes/computers';
import { deviceRoutes } from './routes/devices';
import { eventRoutes } from './routes/events';
import { fileRoutes } from './routes/files';
import { healthRoutes } from './routes/health';
import { proactivityRoutes } from './routes/proactivity';
import { providerRoutes } from './routes/providers';
import { taskRoutes } from './routes/tasks';
import { teamRoutes } from './routes/teams';
import type { Services } from './services';

const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

export const API_PREFIX = '/api/v1';

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { config } = services;
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    trustProxy: config.trustProxy,
  });

  app.decorate('services', services);
  app.decorateRequest('auth', null);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    reply.type('application/problem+json');
    if (error instanceof HttpProblem) {
      return reply.code(error.status).send(problemBody(error.status, error.code, error.message));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const errors = error.validation.map((issue) => ({
        path: issue.instancePath || '/',
        message: issue.message ?? 'Invalid value',
      }));
      return reply
        .code(400)
        .send(problemBody(400, 'validation_failed', 'Request validation failed', { errors }));
    }
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, issues: error.cause.issues },
        'Response serialization failed',
      );
      return reply.code(500).send(problemBody(500, 'internal_error'));
    }
    const { statusCode, code, message } = error as Partial<FastifyError>;
    const status = statusCode && statusCode >= 400 ? statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      return reply.code(500).send(problemBody(500, 'internal_error'));
    }
    const problemCode = status === 429 ? 'rate_limited' : (code ?? 'request_error').toLowerCase();
    return reply.code(status).send(problemBody(status, problemCode, message));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .type('application/problem+json')
      .send(problemBody(404, 'not_found', `No route for ${request.method} ${request.url}`)),
  );

  await app.register(fastifyHelmet);
  await app.register(fastifyCors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Upgraded WebSocket requests can lack a socket address (e.g. injected in tests).
    keyGenerator: (request) => request.ip ?? 'unknown',
  });
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'MowBot API',
        version: pkg.version,
        description: 'API of the MowBot hub. Every client (web, mobile, desktop) uses it.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 * 1024 } });
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 20, fields: 10 },
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(deviceRoutes);
      await api.register(teamRoutes);
      await api.register(computerRoutes);
      await api.register(fileRoutes);
      await api.register(eventRoutes);
      await api.register(providerRoutes);
      await api.register(botRoutes);
      await api.register(taskRoutes);
      await api.register(proactivityRoutes);
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: API_PREFIX },
  );

  services.computers.setLogger(app.log);
  services.runtime.setLogger(app.log);
  app.addHook('onClose', async () => {
    services.scheduler.stop();
    await services.runtime.close();
    await services.computers.close();
  });

  return app;
}
