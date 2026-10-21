import {
  authStatusSchema,
  loginRequestSchema,
  refreshRequestSchema,
  setupRequestSchema,
  type TokenResponse,
  tokenResponseSchema,
} from '@mowbot/contract';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recordAudit, requestContext } from '../audit';
import { hashPassword, verifyPassword } from '../auth/passwords';
import type { DeviceRow, IssuedSession } from '../auth/sessions';
import { ownerExists } from '../auth/setup';
import { isUniqueViolation } from '../db/errors';
import { owner } from '../db/schema';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, HttpProblem, unauthorized } from '../http/problems';

export const REFRESH_COOKIE = 'mowbot_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, sessions, setup, config } = app.services;

  /** Web devices get the refresh token as an httpOnly cookie, never in the JSON body. */
  const sendSession = (
    reply: FastifyReply,
    device: Pick<DeviceRow, 'kind'>,
    session: IssuedSession,
  ): TokenResponse => {
    const body: TokenResponse = {
      deviceId: session.deviceId,
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
    };
    if (device.kind !== 'web') return { ...body, refreshToken: session.refreshToken };
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshTokenExpiresAt,
    });
    return body;
  };

  const clearRefreshCookie = (reply: FastifyReply) =>
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });

  app.get(
    '/auth/status',
    {
      schema: {
        tags: ['auth'],
        operationId: 'getAuthStatus',
        response: { 200: authStatusSchema, ...errorResponses },
      },
    },
    async () => ({ setupRequired: !(await ownerExists(db)) }),
  );

  app.post(
    '/auth/setup',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        operationId: 'setup',
        description: 'Creates the owner account. Requires the setup token printed in the hub logs.',
        body: setupRequestSchema,
        response: { 201: tokenResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const ctx = requestContext(request);
      if (await ownerExists(db)) throw new HttpProblem(409, 'already_set_up', 'Owner exists');
      if (!setup.check(request.body.setupToken)) {
        await recordAudit(db, { actorType: 'anonymous', action: 'auth.setup_failed', ...ctx });
        throw new HttpProblem(401, 'invalid_setup_token', 'Invalid setup token');
      }

      const passwordHash = await hashPassword(request.body.password);
      let created: typeof owner.$inferSelect | undefined;
      try {
        [created] = await db
          .insert(owner)
          .values({ displayName: request.body.displayName, passwordHash })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpProblem(409, 'already_set_up', 'Owner exists');
        throw error;
      }
      if (!created) throw new Error('Owner insert returned no row');
      setup.complete();
      await app.services.bootstrap();

      const device = await sessions.createDevice(created.id, request.body.device);
      const session = await sessions.issue(created.id, device.id, device.scopes);
      await recordAudit(db, {
        actorType: 'owner',
        actorId: created.id,
        action: 'auth.setup',
        ...ctx,
        data: { deviceId: device.id },
      });
      return reply.code(201).send(sendSession(reply, device, session));
    },
  );

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        operationId: 'login',
        body: loginRequestSchema,
        response: { 200: tokenResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const ctx = requestContext(request);
      const [account] = await db.select().from(owner).limit(1);
      if (!account) throw new HttpProblem(409, 'setup_required', 'No owner yet');
      if (!(await verifyPassword(account.passwordHash, request.body.password))) {
        await recordAudit(db, { actorType: 'anonymous', action: 'auth.login_failed', ...ctx });
        throw new HttpProblem(401, 'invalid_credentials', 'Invalid credentials');
      }

      const device = await sessions.createDevice(account.id, request.body.device);
      const session = await sessions.issue(account.id, device.id, device.scopes);
      await recordAudit(db, {
        actorType: 'owner',
        actorId: account.id,
        action: 'auth.login',
        ...ctx,
        data: { deviceId: device.id, kind: device.kind },
      });
      return sendSession(reply, device, session);
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['auth'],
        operationId: 'refresh',
        description:
          'Rotates the refresh token. Native clients send it in the body; web clients send `{}` and rely on the cookie.',
        body: refreshRequestSchema,
        response: { 200: tokenResponseSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const raw = request.body.refreshToken ?? request.cookies[REFRESH_COOKIE];
      if (!raw) throw unauthorized('Missing refresh token');
      try {
        const { session, device } = await sessions.refresh(raw, requestContext(request));
        return sendSession(reply, device, session);
      } catch (error) {
        if (error instanceof HttpProblem && error.code !== 'refresh_token_race') {
          clearRefreshCookie(reply);
        }
        throw error;
      }
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: requireAuth(),
      schema: {
        tags: ['auth'],
        operationId: 'logout',
        description: 'Revokes the calling device.',
        security: bearerSecurity,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      await sessions.revokeDevice(auth.deviceId);
      await recordAudit(db, {
        actorType: 'device',
        actorId: auth.deviceId,
        action: 'auth.logout',
        ...requestContext(request),
      });
      clearRefreshCookie(reply);
      return reply.code(204).send(null);
    },
  );
};
