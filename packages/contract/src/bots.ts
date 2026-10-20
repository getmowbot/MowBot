import { z } from 'zod';

export const botStatusSchema = z.enum([
  'idle',
  'working',
  'waiting_user',
  'waiting_bot',
  'error',
  'paused',
]);
export type BotStatus = z.infer<typeof botStatusSchema>;

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
]);
export type MessagePart = z.infer<typeof messagePartSchema>;

export const messageKindSchema = z.enum(['chat', 'ask', 'task']);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  /** For incoming messages: the bot that sent it (null: the user). */
  fromBotId: z.uuid().nullable(),
  /** Name of the sending bot when it wrote (kept if that bot is deleted). */
  fromName: z.string().nullable(),
  /** `ask`: a question awaiting this bot's answer; `task`: a task assigned or updated. */
  kind: messageKindSchema,
  taskId: z.uuid().nullable(),
  parts: z.array(messagePartSchema),
  status: z.enum(['streaming', 'done', 'error', 'stopped']),
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
