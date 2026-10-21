import path from 'node:path';
import {
  downloadTicketRequestSchema,
  fileEntrySchema,
  fileListSchema,
  fileSearchQuerySchema,
  fileSearchResultSchema,
  mkdirRequestSchema,
  moveRequestSchema,
  pathQuerySchema,
  ticketSchema,
  uploadResultSchema,
  workspaceIdParamsSchema,
} from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { workspaces } from '../db/schema';
import { authOf, bearerSecurity, requireAuth } from '../http/auth-hook';
import {
  attachmentDisposition,
  contentTypeFor,
  parseRange,
  UNTRUSTED_FILE_HEADERS,
} from '../http/content-types';
import { errorResponses, HttpProblem, notFound } from '../http/problems';
import { normalizePath, parentOf } from '../workspaces/files';

const tags = ['files'];

export const fileRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, files, tickets, events } = app.services;

  const assertWorkspace = async (id: string) => {
    const [row] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, id));
    if (!row) throw notFound('Workspace not found');
  };
  const changed = (workspaceId: string, ...paths: string[]) =>
    events.publish({ type: 'workspace.changed', workspaceId, paths: [...new Set(paths)] });

  app.get(
    '/workspaces/:id/files',
    {
      preHandler: requireAuth('files:read'),
      schema: {
        tags,
        operationId: 'listFiles',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        querystring: pathQuerySchema,
        response: { 200: fileListSchema, ...errorResponses },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      return files.list(request.params.id, request.query.path);
    },
  );

  app.get(
    '/workspaces/:id/files/search',
    {
      preHandler: requireAuth('files:read'),
      schema: {
        tags,
        operationId: 'searchFiles',
        description:
          'Files and folders whose path contains `q` (names starting with it first); without `q`, the files changed last.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        querystring: fileSearchQuerySchema,
        response: { 200: fileSearchResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      return { items: await files.search(request.params.id, request.query.q, request.query.limit) };
    },
  );

  app.get(
    '/workspaces/:id/files/content',
    {
      preHandler: requireAuth('files:read'),
      schema: {
        tags,
        operationId: 'getFileContent',
        description:
          'Raw bytes for previews (supports Range). Active types (HTML, scripts) are served as text.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        querystring: pathQuerySchema,
      },
    },
    async (request, reply) => {
      await assertWorkspace(request.params.id);
      const file = await files.stat(request.params.id, request.query.path);
      if (file.type !== 'file') throw new HttpProblem(400, 'invalid_path', 'Not a file');
      reply.headers({
        ...UNTRUSTED_FILE_HEADERS,
        'content-type': contentTypeFor(file.name),
        'accept-ranges': 'bytes',
      });
      const range = parseRange(request.headers.range, file.size);
      if (range === 'invalid') {
        return reply.code(416).header('content-range', `bytes */${file.size}`).send();
      }
      if (range) {
        reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
          .header('content-length', range.end - range.start + 1);
        return reply.send(files.openRead(file.abs, range));
      }
      reply.header('content-length', file.size);
      return reply.send(files.openRead(file.abs));
    },
  );

  app.post(
    '/workspaces/:id/files/download-ticket',
    {
      preHandler: requireAuth('files:read'),
      schema: {
        tags,
        operationId: 'createDownloadTicket',
        description:
          'One-time link `GET /downloads/{ticket}`: the file itself, or a zip when the path is a folder.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        body: downloadTicketRequestSchema,
        response: { 200: ticketSchema, ...errorResponses },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      const target = await files.stat(request.params.id, request.body.path);
      const auth = authOf(request);
      const { ticket, expiresAt } = tickets.issue({
        kind: 'download',
        ownerId: auth.ownerId,
        deviceId: auth.deviceId,
        data: { workspaceId: request.params.id, path: target.path, type: target.type },
      });
      return { ticket, expiresAt: expiresAt.toISOString() };
    },
  );

  app.get(
    '/downloads/:ticket',
    {
      schema: {
        tags,
        operationId: 'download',
        params: z.object({ ticket: z.string() }),
      },
    },
    async (request, reply) => {
      const grant = tickets.consume(request.params.ticket, 'download');
      if (!grant) throw new HttpProblem(404, 'not_found', 'Download link expired or already used');
      const { workspaceId = '', path: rel = '', type } = grant.data;
      reply.headers(UNTRUSTED_FILE_HEADERS);
      if (type === 'directory') {
        const archive = await files.zip(workspaceId, rel);
        reply
          .header('content-type', 'application/zip')
          .header('content-disposition', attachmentDisposition(archive.name));
        return reply.send(archive.stream);
      }
      const file = await files.stat(workspaceId, rel);
      reply
        .header('content-type', contentTypeFor(file.name))
        .header('content-length', file.size)
        .header('content-disposition', attachmentDisposition(file.name));
      return reply.send(files.openRead(file.abs));
    },
  );

  app.post(
    '/workspaces/:id/files/upload',
    {
      preHandler: requireAuth('files:write'),
      schema: {
        tags,
        operationId: 'uploadFiles',
        description:
          'multipart/form-data, one or more `file` parts, stored in the `path` folder. Existing names get a ` (n)` suffix.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        querystring: pathQuerySchema,
        response: { 200: uploadResultSchema, ...errorResponses },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      if (!request.isMultipart()) {
        throw new HttpProblem(415, 'unsupported_media_type', 'Expected multipart/form-data');
      }
      const entries = [];
      for await (const part of request.files()) {
        entries.push(
          await files.write(request.params.id, request.query.path, part.filename, part.file),
        );
      }
      if (entries.length > 0) changed(request.params.id, normalizePath(request.query.path));
      return { entries };
    },
  );

  app.post(
    '/workspaces/:id/files/mkdir',
    {
      preHandler: requireAuth('files:write'),
      schema: {
        tags,
        operationId: 'createFolder',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        body: mkdirRequestSchema,
        response: { 201: fileEntrySchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      await assertWorkspace(request.params.id);
      const entry = await files.mkdir(request.params.id, request.body.path);
      changed(request.params.id, parentOf(entry.path));
      return reply.code(201).send(entry);
    },
  );

  app.post(
    '/workspaces/:id/files/move',
    {
      preHandler: requireAuth('files:write'),
      schema: {
        tags,
        operationId: 'moveFile',
        description: 'Renames or moves a file or folder. Fails if the target exists.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        body: moveRequestSchema,
        response: { 200: fileEntrySchema, ...errorResponses },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      const entry = await files.move(request.params.id, request.body.from, request.body.to);
      changed(request.params.id, parentOf(normalizePath(request.body.from)), parentOf(entry.path));
      return entry;
    },
  );

  app.delete(
    '/workspaces/:id/files',
    {
      preHandler: requireAuth('files:write'),
      schema: {
        tags,
        operationId: 'deleteFile',
        description: 'Moves to `.trash/`. Deleting inside `.trash/` removes the file for good.',
        security: bearerSecurity,
        params: workspaceIdParamsSchema,
        querystring: pathQuerySchema,
        response: {
          200: z.object({ trashedTo: z.string().nullable() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      await assertWorkspace(request.params.id);
      const rel = normalizePath(request.query.path);
      const result = await files.remove(request.params.id, rel);
      changed(
        request.params.id,
        parentOf(rel),
        ...(result.trashedTo ? [path.posix.dirname(result.trashedTo)] : []),
      );
      return result;
    },
  );
};
