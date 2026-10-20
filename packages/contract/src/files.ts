import { z } from 'zod';

/** Workspace-relative POSIX path, `''` being the workspace root. */
export const workspacePathSchema = z.string().max(1024);

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileListSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
});
export type FileList = z.infer<typeof fileListSchema>;

export const workspaceIdParamsSchema = z.object({
  id: z.uuid(),
});

export const pathQuerySchema = z.object({
  path: workspacePathSchema.default(''),
});

export const mkdirRequestSchema = z.object({
  path: workspacePathSchema.min(1),
});

export const moveRequestSchema = z.object({
  from: workspacePathSchema.min(1),
  to: workspacePathSchema.min(1),
});

export const downloadTicketRequestSchema = z.object({
  path: workspacePathSchema,
});

export const uploadResultSchema = z.object({
  entries: z.array(fileEntrySchema),
});
export type UploadResult = z.infer<typeof uploadResultSchema>;

/** Folder names every workspace starts with. */
export const WORKSPACE_FOLDERS = ['shared', 'bots', 'inbox', 'outputs', 'kb'] as const;
export const TRASH_FOLDER = '.trash';
