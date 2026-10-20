import { z } from 'zod';

export const computerStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error']);
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export const computerKindSchema = z.enum(['team', 'dedicated']);
export type ComputerKind = z.infer<typeof computerKindSchema>;

export const computerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: computerKindSchema,
  teamId: z.uuid().nullable(),
  workspaceId: z.uuid(),
  status: computerStatusSchema,
  statusDetail: z.string().nullable(),
  /** The device currently in control of the desktop (bots' input is paused meanwhile). */
  control: z
    .object({
      deviceId: z.uuid(),
      since: z.iso.datetime(),
    })
    .nullable(),
  lastActivityAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Computer = z.infer<typeof computerSchema>;

export const computerListSchema = z.object({
  items: z.array(computerSchema),
});
export type ComputerList = z.infer<typeof computerListSchema>;

export const computerIdParamsSchema = z.object({
  id: z.uuid(),
});

/** Short-lived, single-use credential for URLs a client cannot attach headers to (WebSocket, download link). */
export const ticketSchema = z.object({
  ticket: z.string(),
  expiresAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof ticketSchema>;
