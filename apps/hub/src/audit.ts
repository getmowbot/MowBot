import type { FastifyRequest } from 'fastify';
import type { Db } from './db/client';
import { auditLog } from './db/schema';

export interface AuditEntry {
  actorType: 'owner' | 'device' | 'system' | 'anonymous';
  actorId?: string | null;
  action: string;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
}

export interface RequestContext {
  ip: string;
  userAgent: string | null;
}

export const requestContext = (request: FastifyRequest): RequestContext => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'] ?? null,
});

export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    data: entry.data ?? null,
  });
}
