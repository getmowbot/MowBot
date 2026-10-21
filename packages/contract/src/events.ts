import { z } from 'zod';
import { botSchema, messageSchema } from './bots';
import { canvasSchema } from './canvases';
import { computerSchema } from './computers';
import { mcpServerSchema } from './mcp';
import { questionSchema } from './questions';
import {
  automationSchema,
  notificationSchema,
  routineSchema,
  systemSettingsSchema,
} from './routines';
import { taskSchema } from './tasks';
import { teamSchema } from './teams';
import { vaultItemSchema } from './vault';

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
  /** A message went away (e.g. an idle check-in tidied up). */
  z.object({ type: z.literal('message.deleted'), botId: z.uuid(), messageId: z.uuid() }),
  z.object({ type: z.literal('canvas.updated'), canvas: canvasSchema }),
  z.object({ type: z.literal('canvas.deleted'), canvasId: z.uuid() }),
  z.object({ type: z.literal('routine.updated'), routine: routineSchema }),
  z.object({ type: z.literal('routine.deleted'), routineId: z.uuid() }),
  z.object({ type: z.literal('automation.updated'), automation: automationSchema }),
  z.object({ type: z.literal('automation.deleted'), automationId: z.uuid() }),
  z.object({ type: z.literal('mcp.updated'), server: mcpServerSchema }),
  z.object({ type: z.literal('mcp.deleted'), serverId: z.uuid() }),
  z.object({ type: z.literal('notification.created'), notification: notificationSchema }),
  /** A bot asked the user something, or the question was answered. */
  z.object({ type: z.literal('question.updated'), question: questionSchema }),
  z.object({ type: z.literal('system.updated'), settings: systemSettingsSchema }),
  /** The user emptied the notifications. */
  z.object({ type: z.literal('notifications.cleared') }),
  /** The user cleared the activity tab: finished tasks are gone, the feed starts over. */
  z.object({ type: z.literal('activity.cleared') }),
  /** A vault entry was saved, refreshed, used or changed (never with its values). */
  z.object({ type: z.literal('vault.updated'), item: vaultItemSchema }),
  z.object({ type: z.literal('vault.deleted'), itemId: z.uuid() }),
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
