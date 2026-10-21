import { z } from 'zod';
import { mcpScopeSchema } from './mcp';

export const connectorOsSchema = z.enum(['windows', 'macos', 'linux']);
export type ConnectorOs = z.infer<typeof connectorOsSchema>;

/** The desktop app of a computer of the user: it lets bots work in the folders shared there. */
export const connectorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** What the app said when it last connected. */
  hostname: z.string().nullable(),
  os: connectorOsSchema.nullable(),
  /** Runs the projects' commands: `powershell`, `bash`, `zsh`… */
  shell: z.string().nullable(),
  version: z.string().nullable(),
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Connector = z.infer<typeof connectorSchema>;

export const connectorCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type ConnectorCreate = z.infer<typeof connectorCreateSchema>;

/** The token is only given here: the desktop app keeps it to connect. */
export const connectorCreatedSchema = z.object({
  connector: connectorSchema,
  token: z.string(),
});
export type ConnectorCreated = z.infer<typeof connectorCreatedSchema>;

export const connectorListSchema = z.object({ items: z.array(connectorSchema) });
export const connectorIdParamsSchema = z.object({ id: z.uuid() });

/** `ask`: the user approves each command; `auto`: bots run commands freely. */
export const projectModeSchema = z.enum(['ask', 'auto']);
export type ProjectMode = z.infer<typeof projectModeSchema>;

/** Which bots may use a project: all, some teams, some bots. */
export const projectScopeSchema = mcpScopeSchema;
export type ProjectScope = z.infer<typeof projectScopeSchema>;

/** A folder the user shared from their computer, through its desktop app. */
export const projectSchema = z.object({
  id: z.uuid(),
  connectorId: z.uuid(),
  name: z.string(),
  /** Where it is on the user's computer. */
  path: z.string(),
  mode: projectModeSchema,
  scope: projectScopeSchema,
  /** Its computer's app is connected: bots can reach it now. */
  online: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

/** Projects are shared and unshared from the desktop app; the hub sets who uses them and how. */
export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  mode: projectModeSchema.optional(),
  scope: projectScopeSchema.optional(),
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectListSchema = z.object({ items: z.array(projectSchema) });
export const projectIdParamsSchema = z.object({ id: z.uuid() });
