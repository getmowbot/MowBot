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

/**
 * Where a mirror stands: `waiting` (no first copy yet, the computer is offline), `syncing`,
 * `synced`, `pending` (changes not yet on the computer: offline, or an update of the app needed),
 * `too_big` (over the size limit: nothing copied), `error`.
 */
export const mirrorStatusSchema = z.enum([
  'waiting',
  'syncing',
  'synced',
  'pending',
  'too_big',
  'error',
]);
export type MirrorStatus = z.infer<typeof mirrorStatusSchema>;

/**
 * A file both sides changed since they last agreed: the user's version stayed in place, the bots'
 * version was kept in their workspace (`copy`).
 */
export const mirrorConflictSchema = z.object({
  /** In the project. */
  path: z.string(),
  /** Workspace path of the bots' version. */
  copy: z.string(),
  at: z.iso.datetime(),
});
export type MirrorConflict = z.infer<typeof mirrorConflictSchema>;

/**
 * The copy of a project in a workspace (a team's, or a solo bot's), kept in sync both ways with
 * the user's folder: the bots work there with their usual tools.
 */
export const projectMirrorSchema = z.object({
  workspaceId: z.uuid(),
  /** Workspace path: `projects/<name>`. */
  folder: z.string(),
  status: mirrorStatusSchema,
  /** Changes made in the mirror that have not reached the computer yet. */
  pending: z.number().int(),
  conflicts: z.array(mirrorConflictSchema),
  /** Why it is `too_big`, `error`, or `pending` for another reason than being offline. */
  error: z.string().nullable(),
  syncedAt: z.iso.datetime().nullable(),
});
export type ProjectMirror = z.infer<typeof projectMirrorSchema>;

/** A folder the user shared from their computer, through its desktop app. */
export const projectSchema = z.object({
  id: z.uuid(),
  connectorId: z.uuid(),
  /** The desktop app's id for the folder (to stop sharing it from there). */
  key: z.string(),
  name: z.string(),
  /** Where it is on the user's computer. */
  path: z.string(),
  mode: projectModeSchema,
  scope: projectScopeSchema,
  /** Its computer's app is connected: bots can reach it now. */
  online: z.boolean(),
  /**
   * Mirrored in the workspaces of the bots that work in it (on by default). Off: bots work in
   * the folder directly, only while the computer is online.
   */
  mirror: z.boolean(),
  /** One per workspace where bots work in it. */
  mirrors: z.array(projectMirrorSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

/** Projects are shared and unshared from the desktop app; the hub sets who uses them and how. */
export const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  mode: projectModeSchema.optional(),
  scope: projectScopeSchema.optional(),
  mirror: z.boolean().optional(),
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const projectListSchema = z.object({ items: z.array(projectSchema) });
export const projectIdParamsSchema = z.object({ id: z.uuid() });

/** Dismisses conflicts of a mirror (all of them without `path`); the bots' copies go to the trash. */
export const mirrorConflictsDismissSchema = z.object({
  workspaceId: z.uuid(),
  path: z.string().optional(),
});
export type MirrorConflictsDismiss = z.infer<typeof mirrorConflictsDismissSchema>;

/** Asks a computer's desktop app to open its folder picker; the folder picked becomes a project. */
export const connectorPickSchema = z.object({
  /** It becomes this bot's active project. */
  botId: z.uuid().optional(),
});
export type ConnectorPick = z.infer<typeof connectorPickSchema>;

/** The project picked, or null when the user cancelled. */
export const connectorPickedSchema = z.object({ project: projectSchema.nullable() });
export type ConnectorPicked = z.infer<typeof connectorPickedSchema>;
