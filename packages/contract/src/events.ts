import { z } from 'zod';
import { botSchema, messageSchema } from './bots';
import { computerSchema } from './computers';
import { taskSchema } from './tasks';
import { teamSchema } from './teams';

/** Messages pushed by the hub on `/api/v1/events`. */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('computer.updated'), computer: computerSchema }),
  z.object({
    type: z.literal('workspace.changed'),
    workspaceId: z.uuid(),
    /** Parent directories whose listing changed. */
    paths: z.array(z.string()),
  }),
  /** A bot was created or changed. */
  z.object({ type: z.literal('bot.updated'), bot: botSchema }),
  z.object({ type: z.literal('bot.deleted'), botId: z.uuid() }),
  /** A team was created or changed. */
  z.object({ type: z.literal('team.updated'), team: teamSchema }),
  z.object({ type: z.literal('team.deleted'), teamId: z.uuid() }),
  z.object({ type: z.literal('task.updated'), task: taskSchema }),
  /** The bot's conversation was cleared. */
  z.object({ type: z.literal('messages.cleared'), botId: z.uuid() }),
  /** A message appeared or reached a checkpoint (tool call/result, end of run). */
  z.object({ type: z.literal('message.updated'), message: messageSchema }),
  /** Streaming text appended to part `partIndex` of a message. */
  z.object({
    type: z.literal('message.delta'),
    botId: z.uuid(),
    messageId: z.uuid(),
    partIndex: z.number().int(),
    kind: z.enum(['text', 'reasoning']),
    text: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
