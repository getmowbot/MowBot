import { z } from 'zod';

/**
 * `open`: awaiting the user; `answered`: the user picked or wrote an answer, which reached the
 * bot as a message; `closed`: the user moved on (wrote to the bot in the chat instead).
 */
export const questionStatusSchema = z.enum(['open', 'answered', 'closed']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

/** A question a bot asks the user, with suggested answers shown as buttons. */
export const questionSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  question: z.string(),
  /** Suggested answers (buttons); the user can also write their own. */
  options: z.array(z.string()),
  status: questionStatusSchema,
  answer: z.string().nullable(),
  answeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionListSchema = z.object({ items: z.array(questionSchema) });

export const questionListQuerySchema = z.object({
  /** Open questions only (default), or the latest ones whatever their status. */
  status: z.enum(['open', 'all']).default('open'),
  botId: z.uuid().optional(),
});

export const questionIdParamsSchema = z.object({ id: z.uuid() });

export const questionAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(2_000),
});
