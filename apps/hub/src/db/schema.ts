import type { DeviceKind, Scope } from '@mowbot/contract';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** MowBot is single-user: at most one owner row, enforced by the `singleton` unique column. */
export const owner = pgTable(
  'owner',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singleton: boolean('singleton').notNull().default(true),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('owner_singleton_unique').on(t.singleton),
    check('owner_singleton_true', sql`${t.singleton}`),
  ],
);

/** A client (web browser, phone, desktop app, CLI) with its own revocable session. */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<DeviceKind>().notNull(),
    scopes: text('scopes').array().$type<Scope[]>().notNull(),
    pushToken: text('push_token'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('devices_owner_idx').on(t.ownerId)],
);

/**
 * Opaque rotating refresh tokens, stored hashed. Every rotation stays in the same family so
 * that reusing a consumed token can revoke the whole chain.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('refresh_tokens_family_idx').on(t.familyId),
    index('refresh_tokens_device_idx').on(t.deviceId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: createdAt(),
    actorType: text('actor_type').$type<'owner' | 'device' | 'system' | 'anonymous'>().notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    data: jsonb('data').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_log_created_idx').on(t.createdAt),
    index('audit_log_action_idx').on(t.action),
  ],
);

/** Small key/value store for instance-level state (signing keys, feature flags…). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
