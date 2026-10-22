import { z } from 'zod';

export const computerStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error']);
export type ComputerStatus = z.infer<typeof computerStatusSchema>;

/**
 * `team`: a team's shared PC; `dedicated`: one bot's own; `mcp`: the PC the MCP servers run on
 * (no desktop, never listed with the others, see `/mcp/computer`).
 */
export const computerKindSchema = z.enum(['team', 'dedicated', 'mcp']);
export type ComputerKind = z.infer<typeof computerKindSchema>;

/**
 * What a PC runs. `desktop`: Ubuntu with its XFCE desktop, which the user watches and takes
 * control of. `terminal`: Ubuntu without a screen, lighter: a shell, files and a browser
 * without a window (no screenshots, no mouse).
 */
export const computerSystemSchema = z.enum(['desktop', 'terminal']);
export type ComputerSystem = z.infer<typeof computerSystemSchema>;

/**
 * The host's graphics cards a PC gets: `all`, some of them by id (`GPU-…`), or none (null).
 * Several PCs can share a card.
 */
export const computerGpusSchema = z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]);
export type ComputerGpus = z.infer<typeof computerGpusSchema>;

export const computerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: computerKindSchema,
  system: computerSystemSchema,
  gpus: computerGpusSchema.nullable(),
  /** Its system or its cards changed while it ran: they apply once it restarts. */
  restartNeeded: z.boolean(),
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

/** Changes what a PC runs; a running PC takes it at its next start. */
export const computerUpdateSchema = z.object({
  system: computerSystemSchema.optional(),
  gpus: computerGpusSchema.nullable().optional(),
});
export type ComputerUpdate = z.infer<typeof computerUpdateSchema>;

/** A graphics card of the hub's host that PCs can use. */
export const gpuSchema = z.object({
  /** The card's UUID (`GPU-…`): what `gpus` names. */
  id: z.string(),
  index: z.number().int(),
  name: z.string(),
  memoryMb: z.number().int().nullable(),
});
export type Gpu = z.infer<typeof gpuSchema>;

/** The host's cards; `available` false when Docker cannot hand any out (no NVIDIA toolkit). */
export const gpuListSchema = z.object({
  available: z.boolean(),
  items: z.array(gpuSchema),
});
export type GpuList = z.infer<typeof gpuListSchema>;

/** Short-lived, single-use credential for URLs a client cannot attach headers to (WebSocket, download link). */
export const ticketSchema = z.object({
  ticket: z.string(),
  expiresAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof ticketSchema>;
