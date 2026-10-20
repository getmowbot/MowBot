import { z } from 'zod';
import { computerSchema } from './computers';

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
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
