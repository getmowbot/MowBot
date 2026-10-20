import { z } from 'zod';

export const teamSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  mission: z.string().nullable(),
  isMain: z.boolean(),
  isolated: z.boolean(),
  workspaceId: z.uuid(),
  computerId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Team = z.infer<typeof teamSchema>;

export const teamListSchema = z.object({
  items: z.array(teamSchema),
});
export type TeamList = z.infer<typeof teamListSchema>;
