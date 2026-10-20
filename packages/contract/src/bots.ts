import { z } from 'zod';

export const botStatusSchema = z.enum(['idle', 'working', 'waiting_user', 'error', 'paused']);
export type BotStatus = z.infer<typeof botStatusSchema>;

export const botSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.string(),
  mission: z.string().nullable(),
  isChef: z.boolean(),
  teamId: z.uuid().nullable(),
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

export const messageSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  role: z.enum(['user', 'assistant']),
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
