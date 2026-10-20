import { z } from 'zod';

export const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  mission: z.string().nullable(),
  isMain: z.boolean(),
  /** Only its lead and the Chef can write to the bots of an isolated team. */
  isolated: z.boolean(),
  leadBotId: z.uuid().nullable(),
  workspaceId: z.uuid(),
  computerId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamListSchema = z.object({
  items: z.array(teamSchema),
});
export type TeamList = z.infer<typeof teamListSchema>;

export const teamIdParamsSchema = z.object({ id: z.uuid() });

export const teamCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  mission: z.string().trim().max(4000).optional(),
  isolated: z.boolean().optional(),
});
export type TeamCreate = z.infer<typeof teamCreateSchema>;

export const teamUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  mission: z.string().trim().max(4000).nullable().optional(),
  isolated: z.boolean().optional(),
  /** Must be a member of the team. */
  leadBotId: z.uuid().nullable().optional(),
});
export type TeamUpdate = z.infer<typeof teamUpdateSchema>;
