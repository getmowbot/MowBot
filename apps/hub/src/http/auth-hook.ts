import type { Scope } from '@mowbot/contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AccessTokenClaims } from '../auth/tokens';
import { forbidden, unauthorized } from './problems';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AccessTokenClaims | null;
  }
}

/** Route `preHandler` that requires a valid bearer access token carrying every given scope. */
export function requireAuth(...scopes: Scope[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    if (!token) throw unauthorized();
    const claims = await request.server.services.sessions.authenticate(token);
    const missing = scopes.filter((scope) => !claims.scopes.includes(scope));
    if (missing.length > 0) throw forbidden(`Missing scope: ${missing.join(', ')}`);
    request.auth = claims;
  };
}

/** Reads `request.auth` in handlers placed behind `requireAuth`. */
export function authOf(request: FastifyRequest): AccessTokenClaims {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

/** OpenAPI security requirement for authenticated routes. */
export const bearerSecurity = [{ bearerAuth: [] }];
