import type {
  BotStatus,
  ComputerKind,
  ComputerStatus,
  DeviceKind,
  Locale,
  Message,
  MessageKind,
  MessagePart,
  ProviderKind,
  Scope,
  TaskStatus,
} from '@mowbot/contract';
import type { ModelMessage } from 'ai';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    locale: text('locale').$type<Locale>().notNull().default('fr'),
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

/** A file tree owned by a team (or a solo bot), mounted on `/workspace` in its computers. */
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerType: text('owner_type').$type<'team' | 'bot'>().notNull(),
  quotaBytes: bigint('quota_bytes', { mode: 'number' }),
  createdAt: createdAt(),
});

export const teams = pgTable(
  'teams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    mission: text('mission'),
    /** The "Équipe principale" created at setup, led by the Chef. */
    isMain: boolean('is_main').notNull().default(false),
    isolated: boolean('isolated').notNull().default(false),
    leadBotId: uuid('lead_bot_id').references((): AnyPgColumn => bots.id, {
      onDelete: 'set null',
    }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('teams_main_unique').on(t.isMain).where(sql`${t.isMain}`)],
);

/** A persistent Docker container with a Linux desktop: a team's shared PC or a dedicated one. */
export const computers = pgTable(
  'computers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').$type<ComputerKind>().notNull(),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    status: text('status').$type<ComputerStatus>().notNull().default('stopped'),
    statusDetail: text('status_detail'),
    containerId: text('container_id'),
    /** Bearer token the hub uses to call the computer's mow-agent, sealed with the master key. */
    agentTokenSealed: text('agent_token_sealed').notNull(),
    controlDeviceId: uuid('control_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    controlSince: timestamp('control_since', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('computers_team_pc_unique').on(t.teamId).where(sql`${t.kind} = 'team'`)],
);

/** An LLM endpoint and its (sealed) API key. */
export const providerProfiles = pgTable('provider_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').$type<ProviderKind>().notNull(),
  baseUrl: text('base_url').notNull(),
  defaultModel: text('default_model'),
  apiKeySealed: text('api_key_sealed'),
  headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bots = pgTable(
  'bots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    mission: text('mission'),
    isChef: boolean('is_chef').notNull().default(false),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    computerId: uuid('computer_id').references(() => computers.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'set null' }),
    model: text('model'),
    status: text('status').$type<BotStatus>().notNull().default('idle'),
    statusDetail: text('status_detail'),
    avatarSeed: text('avatar_seed').notNull(),
    /** The bot that created this one (org chart). */
    managerId: uuid('manager_id').references((): AnyPgColumn => bots.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bots_chef_unique').on(t.isChef).where(sql`${t.isChef}`),
    // Bots address each other by name.
    uniqueIndex('bots_name_unique').on(sql`lower(${t.name})`),
  ],
);

/**
 * One conversation per bot with the owner (bot-to-bot threads come with teams). `parts` is
 * what clients display; `modelMessages` is the exact transcript replayed to the model.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    /** Incoming message written by another bot (null: by the user, or the bot's own answer). */
    fromBotId: uuid('from_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    kind: text('kind').$type<MessageKind>().notNull().default('chat'),
    /** `depth`: how many bot-to-bot hops led here (loop guard); `askId`: question to answer. */
    meta: jsonb('meta').$type<MessageMeta>(),
    parts: jsonb('parts').$type<MessagePart[]>().notNull(),
    modelMessages: jsonb('model_messages').$type<ModelMessage[]>().notNull(),
    status: text('status').$type<'streaming' | 'done' | 'error' | 'stopped'>().notNull(),
    errorCode: text('error_code').$type<MessageErrorCode>(),
    error: text('error'),
    usage: jsonb('usage').$type<{ inputTokens: number; outputTokens: number }>(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_bot_created_idx').on(t.botId, t.createdAt),
    index('messages_from_bot_created_idx').on(t.createdAt).where(sql`${t.fromBotId} is not null`),
  ],
);

export type MessageErrorCode = NonNullable<Message['errorCode']>;

export interface MessageMeta {
  /** Sender's name when it was sent (still shown if that bot is deleted). */
  fromName?: string;
  depth?: number;
  askId?: string;
  taskId?: string;
}

/** Work assigned to a bot by another bot (or by the user). */
export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    details: text('details'),
    status: text('status').$type<TaskStatus>().notNull().default('todo'),
    result: text('result'),
    assigneeBotId: uuid('assignee_bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    creatorBotId: uuid('creator_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('tasks_assignee_idx').on(t.assigneeBotId, t.status)],
);
