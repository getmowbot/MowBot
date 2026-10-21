import { z } from 'zod';
import { canvasContentSchema } from './canvases';
import { vaultFieldSchema } from './vault';

export const botStatusSchema = z.enum([
  'idle',
  'working',
  'waiting_user',
  'waiting_bot',
  'error',
  'paused',
]);
export type BotStatus = z.infer<typeof botStatusSchema>;

/** A model of a provider. */
export const modelRefSchema = z.object({
  providerId: z.uuid(),
  model: z.string().trim().min(1).max(200),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const botSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.string(),
  mission: z.string().nullable(),
  isChef: z.boolean(),
  /** null: a solo bot, outside any team. */
  teamId: z.uuid().nullable(),
  /** The bot that created it (org chart); null for the Chef and bots made by the user. */
  managerId: z.uuid().nullable(),
  computerId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  providerId: z.uuid().nullable(),
  model: z.string().nullable(),
  /** Tried in order when the main model fails (provider down, quota reached…). */
  fallbacks: z.array(modelRefSchema),
  /** Cheaper model for check-ins; null: the main model. */
  lightModel: modelRefSchema.nullable(),
  /** Minutes between the bot's check-ins; null: none. */
  heartbeatMinutes: z.number().int().nullable(),
  /** Tokens per day the bot may spend on what it does on its own; null: no cap. */
  dailyTokenBudget: z.number().int().nullable(),
  status: botStatusSchema,
  statusDetail: z.string().nullable(),
  /** Seed of the bot's character (shape, colors, eyes): see @mowbot/design. */
  avatarSeed: z.string(),
  createdAt: z.iso.datetime(),
});
export type Bot = z.infer<typeof botSchema>;

export const botListSchema = z.object({ items: z.array(botSchema) });

export const botIdParamsSchema = z.object({ id: z.uuid() });

export const botUpdateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  mission: z.string().trim().max(4000).nullable().optional(),
  providerId: z.uuid().nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  fallbacks: z.array(modelRefSchema).max(5).optional(),
  lightModel: modelRefSchema.nullable().optional(),
  heartbeatMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24)
    .nullable()
    .optional(),
  dailyTokenBudget: z.number().int().min(1000).nullable().optional(),
});
export type BotUpdate = z.infer<typeof botUpdateSchema>;

export const botComputerChoiceSchema = z.enum(['team', 'dedicated']);
export type BotComputerChoice = z.infer<typeof botComputerChoiceSchema>;

export const botCreateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(120),
  mission: z.string().trim().max(4000).optional(),
  /** null: a solo bot, with its own PC and workspace. */
  teamId: z.uuid().nullable(),
  /** In a team: share the team's PC (default) or get a dedicated one. Solo bots always get one. */
  computer: botComputerChoiceSchema.default('team'),
  /** Defaults to the Chef's provider and model. */
  providerId: z.uuid().nullable().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  /** Makes the new bot its team's lead. */
  lead: z.boolean().optional(),
});
export type BotCreate = z.infer<typeof botCreateSchema>;

/** Moves a bot to another team (null: solo), on its PC or a dedicated one. */
export const botMoveSchema = z.object({
  teamId: z.uuid().nullable(),
  computer: botComputerChoiceSchema.default('team'),
});
export type BotMove = z.infer<typeof botMoveSchema>;

/** Display parts of a message (the exact model transcript is kept server-side). */
export const messagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    toolCallId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    state: z.enum(['running', 'done', 'error']),
    /** Short human-readable result (truncated). */
    output: z.string().optional(),
    /** Image produced by the tool (e.g. a screenshot), stored in the workspace. */
    image: z.object({ workspaceId: z.uuid(), path: z.string() }).optional(),
  }),
  /** What the bot showed in the conversation: a card, pictures, a score… (images: the bot's workspace or the web). */
  z.object({
    type: z.literal('canvas'),
    content: canvasContentSchema,
    /** Label of the card button the user pressed. */
    pressed: z.string().nullable(),
  }),
  /**
   * The bot asks for a login or a secret: a form with masked fields, answered straight into
   * the vault. The values never enter the conversation, the history or the model.
   */
  z.object({
    type: z.literal('vault_request'),
    kind: z.enum(['login', 'secret']),
    service: z.string(),
    account: z.string().nullable(),
    sites: z.array(z.string()),
    /** Fields to fill in. */
    fields: z.array(vaultFieldSchema),
    /** Why the bot needs it, in a few words. */
    reason: z.string().nullable(),
    /** Entry whose values are replaced (null: a new one); set once saved. */
    itemId: z.uuid().nullable(),
    status: z.enum(['pending', 'saved', 'declined']),
  }),
]);
export type MessagePart = z.infer<typeof messagePartSchema>;

export const messageKindSchema = z.enum(['chat', 'ask', 'task', 'routine']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  /** For incoming messages: the bot that sent it (null: the user). */
  fromBotId: z.uuid().nullable(),
  /** Name of the sending bot when it wrote (kept if that bot is deleted). */
  fromName: z.string().nullable(),
  /** `ask`: a question awaiting this bot's answer; `task`: a task assigned or updated; `routine`: a routine or check-in fired. */
  kind: messageKindSchema,
  taskId: z.uuid().nullable(),
  parts: z.array(messagePartSchema),
  /** Arrived while the bot was working, and taken into its ongoing answer. */
  steered: z.boolean(),
  status: z.enum(['streaming', 'done', 'error', 'stopped']),
  /** Why the answer failed, for clients to word it; `error` keeps the technical detail. */
  errorCode: z.enum(['no_model', 'hub_restart', 'run_failed']).nullable(),
  error: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).nullable(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof messageSchema>;

export const messageListSchema = z.object({
  items: z.array(messageSchema),
  /** Pass as `before` to load older messages; null when the start is reached. */
  nextCursor: z.string().nullable(),
});
export type MessageList = z.infer<typeof messageListSchema>;

export const messageListQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** The user pressed a button of a card the bot showed in a message. */
export const messagePressParamsSchema = z.object({ id: z.uuid(), messageId: z.uuid() });
export const messagePressSchema = z.object({
  part: z.number().int().min(0).max(500),
  button: z.number().int().min(0).max(2),
});

/**
 * The user answers a bot's vault request: the values go into the vault (never into the
 * conversation), or the user declines.
 */
export const vaultRequestAnswerSchema = z.object({
  part: z.number().int().min(0).max(500),
  values: z
    .object({
      username: z.string().max(500).optional(),
      password: z.string().max(10_000).optional(),
      totp: z.string().max(500).optional(),
      value: z.string().max(10_000).optional(),
    })
    .optional(),
  declined: z.boolean().optional(),
});
export type VaultRequestAnswer = z.infer<typeof vaultRequestAnswerSchema>;

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
});

/** Messages between bots, newest page first. */
export const feedItemSchema = messageSchema.extend({ toBotId: z.uuid() });
export const feedSchema = z.object({
  items: z.array(feedItemSchema),
  nextCursor: z.string().nullable(),
});
export type FeedItem = z.infer<typeof feedItemSchema>;

/** What a bot's own Chrome window shows, for the live view. */
export const botBrowserSchema = z.object({
  /** false: the bot has no page open (or the hub restarted since). */
  open: z.boolean(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  /** JPEG, base64. */
  image: z.string().nullable(),
});
export type BotBrowser = z.infer<typeof botBrowserSchema>;
