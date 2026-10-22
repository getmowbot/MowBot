import type {
  AutomationOutcome,
  AutomationStatus,
  AutomationStop,
  BotStatus,
  CanvasContent,
  CanvasSize,
  ChatgptStatus,
  ComputerGpus,
  ComputerKind,
  ComputerStatus,
  ComputerSystem,
  ConnectorOs,
  DeviceKind,
  Locale,
  McpAuth,
  McpScope,
  McpStatus,
  McpTransport,
  MemoryKind,
  Message,
  MessageKind,
  MessageMention,
  MessagePart,
  MirrorConflict,
  MirrorStatus,
  ModelRef,
  NotificationPriority,
  PlanStepStatus,
  ProjectMode,
  ProjectScope,
  ProviderKind,
  PushPrefs,
  QuestionStatus,
  RoutineKind,
  RoutineRunReason,
  RoutineRunStatus,
  RoutineTrigger,
  Scope,
  TaskStatus,
  VaultAction,
  VaultField,
  VaultKind,
  VaultPolicy,
} from '@mowbot/contract';
import type { ModelMessage } from 'ai';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
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
    /** What this device wants pushed (null: the defaults). */
    pushPrefs: jsonb('push_prefs').$type<PushPrefs>(),
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
  /** `mcp`: the MCP computer's own (no team or bot sees it). */
  ownerType: text('owner_type').$type<'team' | 'bot' | 'mcp'>().notNull(),
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

/**
 * A persistent Docker container with a Linux desktop: a team's shared PC or a dedicated one;
 * or the MCP computer (no desktop), where the MCP servers run.
 */
export const computers = pgTable(
  'computers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').$type<ComputerKind>().notNull(),
    /** What it runs (with a desktop or not), and the host's graphics cards it gets. */
    system: text('system').$type<ComputerSystem>().notNull().default('desktop'),
    gpus: jsonb('gpus').$type<ComputerGpus>(),
    /** The setup its container was made with (`setupKey`): another one waits for a restart. */
    appliedSetup: text('applied_setup'),
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
  (t) => [
    uniqueIndex('computers_team_pc_unique').on(t.teamId).where(sql`${t.kind} = 'team'`),
    uniqueIndex('computers_mcp_pc_unique').on(t.kind).where(sql`${t.kind} = 'mcp'`),
  ],
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
  /** `openai-chatgpt`: the OAuth tokens (sealed JSON, see providers/chatgpt.ts). */
  oauthSealed: text('oauth_sealed'),
  /** `openai-chatgpt`: who signed in and the state of the session (no secret). */
  oauthAccount: jsonb('oauth_account').$type<OAuthAccount>(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface OAuthAccount {
  /** The client OpenAI issued for this registration (`oaiapp_…`). */
  clientId: string;
  /** `sub` of the ID token: a new sign-in must be the same account. */
  subject: string;
  email: string | null;
  planType: string | null;
  status: ChatgptStatus;
  detail: string | null;
  signedInAt: string;
}

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
    /** What the bot says it is working on (set_focus), until it clears it. */
    focus: text('focus'),
    avatarSeed: text('avatar_seed').notNull(),
    fallbacks: jsonb('fallbacks').$type<ModelRef[]>().notNull().default([]),
    lightModel: jsonb('light_model').$type<ModelRef>(),
    heartbeatMinutes: integer('heartbeat_minutes'),
    dailyTokenBudget: integer('daily_token_budget'),
    /** The bot that created this one (org chart). */
    managerId: uuid('manager_id').references((): AnyPgColumn => bots.id, { onDelete: 'set null' }),
    /** The project it works in (folder shared from the user's computer): local_* default to it. */
    projectId: uuid('project_id').references((): AnyPgColumn => projects.id, {
      onDelete: 'set null',
    }),
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
  /** From another bot: the message in a few words, as the apps show it folded. */
  summary?: string;
  depth?: number;
  askId?: string;
  taskId?: string;
  routineId?: string;
  runId?: string;
  /** On an answer: the bot acted on its own (routine, other bots), not for the user. */
  autonomous?: boolean;
  /** On an answer: cut by the step limit (the bot summed up what is left). */
  stepLimit?: boolean;
  /** The hub telling the bot to go on after the step limit: how many times in a row. */
  resume?: number;
  /** Arrived while the bot was working and joined that answer (id): already handled. */
  steeredInto?: string;
  /** Context only (e.g. "stopped by …"): does not call for an answer. */
  silent?: boolean;
  /**
   * Woke the bot for its own initiative or the Chef's watch: the apps never get it, only what
   * the bot does about it.
   */
  unseen?: boolean;
  /** What the user pointed at with @ in the message. */
  mentions?: MessageMention[];
  /** A note that the user changed the project the bot works in. */
  projectNote?: boolean;
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

/** Something a bot does on a schedule or on an event, without being asked. */
export const routines = pgTable(
  'routines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<RoutineKind>().notNull().default('custom'),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    trigger: jsonb('trigger').$type<RoutineTrigger>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    silent: boolean('silent').notNull().default(true),
    createdBy: text('created_by').$type<'bot' | 'user' | 'system'>().notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status').$type<RoutineRunStatus>(),
    failures: integer('failures').notNull().default(0),
    /** Secret of the webhook URL, sealed with the master key. */
    webhookTokenSealed: text('webhook_token_sealed'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('routines_due_idx').on(t.nextRunAt).where(sql`${t.enabled}`),
    uniqueIndex('routines_heartbeat_unique').on(t.botId).where(sql`${t.kind} = 'heartbeat'`),
  ],
);

export const routineRuns = pgTable(
  'routine_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    routineId: uuid('routine_id')
      .notNull()
      .references(() => routines.id, { onDelete: 'cascade' }),
    status: text('status').$type<RoutineRunStatus>().notNull(),
    reason: text('reason').$type<RoutineRunReason>(),
    detail: text('detail'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('routine_runs_routine_idx').on(t.routineId, t.startedAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    priority: text('priority').$type<NotificationPriority>().notNull(),
    title: text('title').notNull(),
    body: text('body'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);

/** A question a bot asked the user, with suggested answers (buttons). */
/** What the bots know about the user, whichever heard it (see memorySchema in the contract). */
export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<MemoryKind>().notNull(),
    text: text('text').notNull(),
    /** When it happens (events). */
    at: timestamp('at', { withTimezone: true }),
    sourceBotId: uuid('source_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memories_at_idx').on(t.at)],
);

export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    options: jsonb('options').$type<string[]>().notNull(),
    /** What helps decide: a few lines, a picture (workspace path or web address), a link. */
    details: text('details'),
    image: text('image'),
    link: jsonb('link').$type<{ label: string; url: string }>(),
    status: text('status').$type<QuestionStatus>().notNull().default('open'),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    /** Asking the user to let the bot use this vault entry. */
    vaultItemId: uuid('vault_item_id').references((): AnyPgColumn => vaultItems.id, {
      onDelete: 'cascade',
    }),
    /** Asking the user to let the bot run this command in a project of theirs. */
    projectCommand: jsonb('project_command').$type<{ projectId: string; command: string }>(),
    createdAt: createdAt(),
  },
  (t) => [index('questions_status_created_idx').on(t.status, t.createdAt)],
);

/** A card a bot pins on the home page (score, list, note…), updated in place by its key. */
export const canvases = pgTable(
  'canvases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    size: text('size').$type<CanvasSize>().notNull().default('s'),
    content: jsonb('content').$type<CanvasContent>().notNull(),
    position: integer('position').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    collapsed: boolean('collapsed').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('canvases_bot_key_unique').on(t.botId, t.key)],
);

/**
 * The vault: browser sessions, logins and secrets. Values are sealed with a key of their own
 * (`dekSealed`, itself sealed with the master key) and never leave the hub.
 */
export const vaultItems = pgTable(
  'vault_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<VaultKind>().notNull(),
    service: text('service').notNull(),
    account: text('account'),
    /** Registrable domains, e.g. ["google.com"]; a session's first site identifies it. */
    sites: jsonb('sites').$type<string[]>().notNull().default([]),
    notes: text('notes'),
    policy: text('policy').$type<VaultPolicy>().notNull().default('auto'),
    fields: jsonb('fields').$type<VaultField[]>().notNull().default([]),
    computerId: uuid('computer_id').references(() => computers.id, { onDelete: 'set null' }),
    createdByBotId: uuid('created_by_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    session: jsonb('session').$type<{ cookies: number; origins: number }>(),
    dekSealed: text('dek_sealed').notNull(),
    payloadSealed: text('payload_sealed').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vault_items_computer_idx').on(t.computerId)],
);

/** Bots the user allowed to use an `ask` entry. */
export const vaultGrants = pgTable(
  'vault_grants',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [unique('vault_grants_item_bot_unique').on(t.itemId, t.botId)],
);

/** History of each vault entry: captures, uses, requests and decisions. */
export const vaultEvents = pgTable(
  'vault_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemId: uuid('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    action: text('action').$type<VaultAction>().notNull(),
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    computerId: uuid('computer_id').references(() => computers.id, { onDelete: 'set null' }),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('vault_events_item_created_idx').on(t.itemId, t.createdAt)],
);

/** A bot's script run by the hub on the bot's computer at a steady pace (no model involved). */
export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    botId: uuid('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    command: text('command').notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    /** Removed with the canvas: the user took the card off, the automation has no purpose. */
    canvasId: uuid('canvas_id').references(() => canvases.id, { onDelete: 'cascade' }),
    until: timestamp('until', { withTimezone: true }),
    status: text('status').$type<AutomationStatus>().notNull().default('active'),
    runs: integer('runs').notNull().default(0),
    failures: integer('failures').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastOutcome: jsonb('last_outcome').$type<AutomationOutcome>(),
    stop: jsonb('stop').$type<AutomationStop>(),
    createdAt: createdAt(),
  },
  (t) => [index('automations_status_idx').on(t.status)],
);

/** What the hub keeps of a tool an MCP server offers (its schema included, for the bots). */
export interface StoredMcpTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  readOnly: boolean | null;
  destructive: boolean | null;
}

/** An MCP server: tools from elsewhere for the bots (secrets and OAuth tokens sealed). */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    transport: text('transport').$type<McpTransport>().notNull(),
    url: text('url'),
    command: text('command'),
    auth: text('auth').$type<McpAuth>().notNull().default('none'),
    secretsSealed: text('secrets_sealed'),
    secretKeys: jsonb('secret_keys').$type<string[]>().notNull().default([]),
    oauthSealed: text('oauth_sealed'),
    scope: jsonb('scope').$type<McpScope>().notNull().default({ kind: 'all', ids: [] }),
    /** Legacy: installed by a bot on its own computer (null: runs on the MCP computer). */
    computerId: uuid('computer_id').references(() => computers.id, { onDelete: 'cascade' }),
    createdByBotId: uuid('created_by_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status').$type<McpStatus>().notNull().default('unknown'),
    statusDetail: text('status_detail'),
    tools: jsonb('tools').$type<StoredMcpTool[]>().notNull().default([]),
    toolsAt: timestamp('tools_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mcp_servers_slug_unique').on(t.slug)],
);

/** Recent tool calls of each MCP server, for the user to see what bots did with it. */
export const mcpCalls = pgTable(
  'mcp_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    ok: boolean('ok').notNull(),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('mcp_calls_server_created_idx').on(t.serverId, t.createdAt)],
);

/** The desktop app of a computer of the user, connected with its own token. */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    hostname: text('hostname'),
    os: text('os').$type<ConnectorOs>(),
    shell: text('shell'),
    version: text('version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('connectors_token_hash_unique').on(t.tokenHash)],
);

/** A folder the user shared from a computer: bots read, write and run commands in it. */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: uuid('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    /** The desktop app's id for the folder. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mode: text('mode').$type<ProjectMode>().notNull().default('ask'),
    scope: jsonb('scope').$type<ProjectScope>().notNull().default({ kind: 'all', ids: [] }),
    /** Mirrored in the workspaces of the bots working in it (off: bots work in it directly). */
    mirror: boolean('mirror').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_connector_key_unique').on(t.connectorId, t.key)],
);

/**
 * The copy of a project in a workspace, kept in sync both ways with the user's folder. The hashes
 * of the last state both sides agreed on are in the workspace (`.mowbot/mirrors/<id>.json`).
 */
export const projectMirrors = pgTable(
  'project_mirrors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Workspace path, chosen once (`projects/<name>`, `projects/<name>-2`…). */
    folder: text('folder').notNull(),
    status: text('status').$type<MirrorStatus>().notNull().default('waiting'),
    pending: integer('pending').notNull().default(0),
    conflicts: jsonb('conflicts').$type<MirrorConflict[]>().notNull().default([]),
    error: text('error'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('project_mirrors_project_workspace_unique').on(t.projectId, t.workspaceId)],
);

/** A command the user allowed once, for a bot in a project (used up when it runs). */
export const projectGrants = pgTable('project_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  botId: uuid('bot_id')
    .notNull()
    .references(() => bots.id, { onDelete: 'cascade' }),
  command: text('command').notNull(),
  createdAt: createdAt(),
});

/** A dev server of a bot's PC, served to the user on one of the hub's preview ports. */
export const previews = pgTable(
  'previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    computerId: uuid('computer_id')
      .notNull()
      .references(() => computers.id, { onDelete: 'cascade' }),
    botId: uuid('bot_id').references(() => bots.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Where the dev server listens on the PC. */
    port: integer('port').notNull(),
    /** The hub's port it is served on. */
    publicPort: integer('public_port').notNull(),
    path: text('path').notNull().default('/'),
    /** The secret of its link, sealed with the master key. */
    tokenSealed: text('token_sealed').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('previews_public_port_unique').on(t.publicPort),
    uniqueIndex('previews_computer_port_unique').on(t.computerId, t.port),
  ],
);

/** A team's plan of attack: its goal, then its steps in order (`planSteps`). One per team. */
export const teamPlans = pgTable('team_plans', {
  teamId: uuid('team_id')
    .primaryKey()
    .references(() => teams.id, { onDelete: 'cascade' }),
  goal: text('goal').notNull(),
  /** The user's project it is about. */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  /** null: written by the user. */
  authorBotId: uuid('author_bot_id').references(() => bots.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A step of a team's plan; one that carries a task follows its status. */
export const planSteps = pgTable(
  'plan_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teamPlans.teamId, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    status: text('status').$type<PlanStepStatus>().notNull().default('todo'),
    ownerBotId: uuid('owner_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** What it will deliver; what it delivered (once done) and where that is. */
    deliverable: text('deliverable'),
    result: text('result'),
    link: text('link'),
  },
  (t) => [
    index('plan_steps_team_idx').on(t.teamId, t.position),
    index('plan_steps_task_idx').on(t.taskId),
  ],
);
