import { z } from 'zod';

export const taskStatusSchema = z.enum(['todo', 'doing', 'blocked', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Work assigned to a bot, by another bot or by the user. */
export const taskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  details: z.string().nullable(),
  status: taskStatusSchema,
  /** What the assignee reports when it is done (or why it is blocked). */
  result: z.string().nullable(),
  assigneeBotId: z.uuid(),
  /** null: assigned by the user. */
  creatorBotId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;

export const taskListSchema = z.object({ items: z.array(taskSchema) });

export const taskListQuerySchema = z.object({
  botId: z.uuid().optional(),
  status: taskStatusSchema.optional(),
});

export const taskIdParamsSchema = z.object({ id: z.uuid() });

export const taskCreateSchema = z.object({
  assigneeBotId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().max(8000).optional(),
});
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().max(8000).nullable().optional(),
  status: taskStatusSchema.optional(),
  result: z.string().trim().max(8000).nullable().optional(),
});
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
