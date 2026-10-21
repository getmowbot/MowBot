import { z } from 'zod';

/** When a routine fires. Event triggers are preferred to polling with crons. */
export const routineTriggerSchema = z.discriminatedUnion('type', [
  /** Standard 5-field cron expression, in the hub's time zone. */
  z.object({ type: z.literal('cron'), expr: z.string().trim().min(9).max(100) }),
  z.object({
    type: z.literal('interval'),
    minutes: z
      .number()
      .int()
      .min(5)
      .max(60 * 24 * 31),
  }),
  z.object({ type: z.literal('once'), at: z.iso.datetime({ offset: true }) }),
  /** Fired by a POST on the routine's secret webhook URL. */
  z.object({ type: z.literal('webhook') }),
]);
export type RoutineTrigger = z.infer<typeof routineTriggerSchema>;

/** `heartbeat`: the bot's periodic check-in; `digest`: the Chef's daily summary. */
export const routineKindSchema = z.enum(['custom', 'heartbeat', 'digest']);
export type RoutineKind = z.infer<typeof routineKindSchema>;

export const routineRunStatusSchema = z.enum(['running', 'done', 'idle', 'error', 'skipped']);
export type RoutineRunStatus = z.infer<typeof routineRunStatusSchema>;

export const routineSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  kind: routineKindSchema,
  name: z.string(),
  /** What the bot is asked to do when it fires. */
  prompt: z.string(),
  trigger: routineTriggerSchema,
  enabled: z.boolean(),
  /** Silent routines do not notify the user (they are still listed and logged). */
  silent: z.boolean(),
  createdBy: z.enum(['bot', 'user', 'system']),
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  lastStatus: routineRunStatusSchema.nullable(),
  /** Consecutive failures; the routine is switched off after a few. */
  failures: z.number().int(),
  /** Only for webhook routines, and only to the user: the URL to call. */
  webhookUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Routine = z.infer<typeof routineSchema>;

export const routineListSchema = z.object({ items: z.array(routineSchema) });
export const routineListQuerySchema = z.object({ botId: z.uuid().optional() });
export const routineIdParamsSchema = z.object({ id: z.uuid() });

export const routineCreateSchema = z.object({
  botId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4000),
  trigger: routineTriggerSchema,
  silent: z.boolean().optional(),
});
export type RoutineCreate = z.infer<typeof routineCreateSchema>;

export const routineUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  trigger: routineTriggerSchema.optional(),
  enabled: z.boolean().optional(),
  silent: z.boolean().optional(),
});
export type RoutineUpdate = z.infer<typeof routineUpdateSchema>;

/** Why a run was skipped or cut short (the apps word it). */
export const routineRunReasonSchema = z.enum([
  'bot_deleted',
  'paused',
  'still_running',
  'quiet_hours',
  'budget_bot',
  'budget_all',
  'interrupted',
]);
export type RoutineRunReason = z.infer<typeof routineRunReasonSchema>;

export const routineRunSchema = z.object({
  id: z.uuid(),
  routineId: z.uuid(),
  status: routineRunStatusSchema,
  /** Why it was skipped or cut short. */
  reason: routineRunReasonSchema.nullable(),
  /** Why it failed (the error), when there is no reason code. */
  detail: z.string().nullable(),
  /** The bot's answer in its conversation (null once tidied away, e.g. an idle check-in). */
  messageId: z.uuid().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RoutineRun = z.infer<typeof routineRunSchema>;
export const routineRunListSchema = z.object({ items: z.array(routineRunSchema) });

export const notificationPrioritySchema = z.enum(['digest', 'normal', 'urgent']);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

/** Something a bot (or the hub) wants the user to know. */
export const notificationSchema = z.object({
  id: z.uuid(),
  /** null: written by the hub itself (budget reached, routine switched off…). */
  botId: z.uuid().nullable(),
  priority: notificationPrioritySchema,
  title: z.string(),
  body: z.string().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;
export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number().int(),
});
export const notificationReadSchema = z.object({
  /** Omitted: all of them. */
  ids: z.array(z.uuid()).max(200).optional(),
});

/** Instance-wide settings of proactivity. */
export const systemSettingsSchema = z.object({
  /** Kill switch: bots do nothing on their own (they still answer the user). */
  paused: z.boolean(),
  /** Check-ins don't fire in this window (local time, "HH:MM"); null: never quiet. */
  quietHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    })
    .nullable(),
  /** Tokens (in + out) all bots may spend per day on what they do on their own; null: no cap. */
  dailyTokenBudget: z.number().int().min(1000).nullable(),
  timeZone: z.string(),
});
export type SystemSettings = z.infer<typeof systemSettingsSchema>;
export const systemSettingsUpdateSchema = systemSettingsSchema.omit({ timeZone: true }).partial();
export type SystemSettingsUpdate = z.infer<typeof systemSettingsUpdateSchema>;

/**
 * Automations: a script a bot wrote, run by the hub on the bot's computer at a steady pace,
 * without waking the bot (no model, no tokens). Its output updates a home page canvas,
 * notifies the user, wakes the bot when something happens, or ends the automation.
 */
export const automationStatusSchema = z.enum(['active', 'paused', 'stopped']);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

export const automationSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  name: z.string(),
  /** Shell command run on the bot's computer (in /workspace). */
  command: z.string(),
  intervalSeconds: z.number().int(),
  /** The home page canvas it keeps up to date (null: it only notifies or wakes the bot). */
  canvasId: z.uuid().nullable(),
  /** Stops by itself at this time. */
  until: z.iso.datetime().nullable(),
  status: automationStatusSchema,
  runs: z.number().int(),
  /** Consecutive failures; paused after a few, and the bot is told. */
  failures: z.number().int(),
  lastRunAt: z.iso.datetime().nullable(),
  /** What the last run did, or why it failed (the apps word it). */
  lastOutcome: z
    .object({
      ok: z.boolean(),
      /** What the script asked for. */
      actions: z.array(z.enum(['canvas', 'notify', 'wake'])),
      error: z
        .object({
          kind: z.enum(['exit', 'timeout', 'output', 'no_canvas', 'no_computer', 'other']),
          /** Exit code of the script. */
          code: z.number().int().nullable(),
          /** The script's own words (stderr) or the details of what is wrong. */
          detail: z.string(),
        })
        .nullable(),
    })
    .nullable(),
  /** Why it stopped or paused on its own: done (detail: the script's words), deadline, failures (detail: how many). */
  stop: z
    .object({
      reason: z.enum(['done', 'deadline', 'failures']),
      detail: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.iso.datetime(),
});
export type Automation = z.infer<typeof automationSchema>;
export type AutomationOutcome = NonNullable<Automation['lastOutcome']>;
export type AutomationStop = NonNullable<Automation['stop']>;

export const automationListSchema = z.object({ items: z.array(automationSchema) });
export const automationIdParamsSchema = z.object({ id: z.uuid() });

/** The user pauses or resumes an automation. */
export const automationUpdateSchema = z.object({ status: z.enum(['active', 'paused']) });
