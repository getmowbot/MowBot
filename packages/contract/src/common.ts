import { z } from 'zod';

/** RFC 9457 problem details, returned by every error response. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  time: z.iso.datetime(),
});
export type Health = z.infer<typeof healthSchema>;
