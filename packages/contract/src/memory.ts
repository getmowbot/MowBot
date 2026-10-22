import { z } from 'zod';

/**
 * What a memory is about. `profile`: who the user is (name, email, birthday, address, job);
 * `preference`: what they like, use or want (an artist, their music app, a diet); `event`: a
 * dated thing (a competition, a flight, a deadline), with `at`; `note`: anything else worth
 * keeping. Secrets never go there: they go to the vault.
 */
export const memoryKindSchema = z.enum(['profile', 'preference', 'event', 'note']);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Longest memory: one fact, in a sentence or two. */
export const MEMORY_TEXT_MAX = 500;

/**
 * Something the bots know about the user, whichever bot heard it: every bot reads the
 * organisation's memory, and keeps it up to date.
 */
export const memorySchema = z.object({
  id: z.uuid(),
  kind: memoryKindSchema,
  text: z.string(),
  /** When it happens (events). */
  at: z.iso.datetime().nullable(),
  /** The bot that heard it (null: the user wrote it here). */
  sourceBotId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Memory = z.infer<typeof memorySchema>;

export const memoryListSchema = z.object({ items: z.array(memorySchema) });

export const memoryIdParamsSchema = z.object({ id: z.uuid() });

export const memoryCreateSchema = z.object({
  kind: memoryKindSchema,
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
  at: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type MemoryCreate = z.infer<typeof memoryCreateSchema>;

export const memoryUpdateSchema = memoryCreateSchema.partial();
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

/**
 * Something a bot planned to do for the user on its own, at a time it chose (the evening
 * before a competition, the morning of a flight): not one of the user's routines, but listed
 * so they can see and cancel it.
 */
export const initiativeSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  /** What the bot will do then, in its words. */
  what: z.string(),
  at: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Initiative = z.infer<typeof initiativeSchema>;

export const initiativeListSchema = z.object({ items: z.array(initiativeSchema) });

/**
 * How much the Chef looks after the user on its own, without being asked: `off`; `light`, a
 * look in the morning and at the end of the day; `active`, every two hours in the day. It goes
 * through the user's connected services (mail, calendar…) and their memory.
 */
export const watchLevelSchema = z.enum(['off', 'light', 'active']);
export type WatchLevel = z.infer<typeof watchLevelSchema>;

/**
 * The bots' memory of the user and their own initiatives work unseen: the apps never show
 * these calls (in a conversation, or as what a bot is doing). Only the hub's logs tell.
 */
export const SILENT_TOOLS: ReadonlySet<string> = new Set([
  'remember',
  'recall',
  'forget',
  'plan_initiative',
  'cancel_initiative',
]);
