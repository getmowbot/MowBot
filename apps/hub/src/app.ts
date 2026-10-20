import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
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
import { deviceRoutes } from './routes/devices';
import { healthRoutes } from './routes/health';
import type { Services } from './services';

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
  await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: '1 minute' });
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

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(deviceRoutes);
      api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
    },
    { prefix: API_PREFIX },
  );

  return app;
}
