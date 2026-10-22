import { z } from 'zod';

/**
 * `open`: awaiting the user; `answered`: the user picked or wrote an answer, which reached the
 * bot as a message; `closed`: the user moved on (wrote to the bot in the chat instead).
 */
export const questionStatusSchema = z.enum(['open', 'answered', 'closed']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

/** Where a question points to: a page to see before answering (the product, the form). */
export const questionLinkSchema = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.url({ protocol: /^https?$/ }).max(2_000),
});
export type QuestionLink = z.infer<typeof questionLinkSchema>;

/**
 * A question a bot asks the user, with suggested answers shown as buttons, and what helps decide:
 * a few lines, a picture, a link (apps show it as a sheet, a modal).
 */
export const questionSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  question: z.string(),
  /** Suggested answers (buttons); the user can also write their own. */
  options: z.array(z.string()),
  /** Markdown: what the bot found or prepared (« 89 € au lieu de 129 €, taille 42 »). */
  details: z.string().nullable(),
  /** A picture: a path in the bot's workspace, or a web address. */
  image: z.string().nullable(),
  link: questionLinkSchema.nullable(),
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
