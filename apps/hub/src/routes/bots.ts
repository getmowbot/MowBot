import {
  attachmentUploadSchema,
  botBrowserSchema,
  botCreateSchema,
  botIdParamsSchema,
  botListSchema,
  botMoveSchema,
  botProjectSchema,
  botSchema,
  botUpdateSchema,
  type FileEntry,
  MAX_ATTACHMENTS,
  messageListQuerySchema,
  messageListSchema,
  messagePressParamsSchema,
  messagePressSchema,
  messageSchema,
  sendMessageSchema,
  vaultRequestAnswerSchema,
  voiceFieldsSchema,
} from '@mowbot/contract';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { INBOX, toAttachment } from '../agents/attachments';
import { type BotRow, toBot, toMessage } from '../bots/service';
import { messages } from '../db/schema';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses, HttpProblem } from '../http/problems';
import { audioTypeOf, parsePeaks, voiceExtension } from '../voice/audio';

const tags = ['bots'];

/** A file sent in a conversation (a document, a photo, a video…). */
const ATTACHMENT_MAX_BYTES = 100 * 1024 ** 2;
/** About an hour of speech, whatever the format. */
const VOICE_MAX_BYTES = 25 * 1024 ** 2;

/** `voice-2026-10-21-143205`, in the hub's time zone. */
function voiceName(now: Date, timeZone: string): string {
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);
  return `voice-${stamp.replace(' ', '-').replaceAll(':', '')}`;
}

function workspaceOf(bot: BotRow): string {
  if (!bot.workspaceId) throw new HttpProblem(409, 'no_workspace', 'This bot has no workspace');
  return bot.workspaceId;
}

export const botRoutes: FastifyPluginAsyncZod = async (app) => {
  const { bots, runtime, providers, db, files, org, routines, events } = app.services;

  app.get(
    '/bots',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listBots',
        security: bearerSecurity,
        response: { 200: botListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await bots.list() }),
  );

  app.post(
    '/bots',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'createBot',
        description:
          "Creates a bot in a team (on the team's PC or a dedicated one) or solo (own PC and workspace).",
        security: bearerSecurity,
        body: botCreateSchema,
        response: { 201: botSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (request.body.providerId) await providers.row(request.body.providerId);
      return reply.code(201).send(await org.createBot(request.body));
    },
  );

  app.delete(
    '/bots/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'deleteBot',
        description:
          "Deletes a bot (not the Chef) and its conversation. A dedicated PC goes with it; a solo bot's files move to the main team's trash.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const row = await bots.row(request.params.id);
      if (row.isChef) throw new HttpProblem(409, 'chef', 'The Chef cannot be deleted');
      await runtime.forget(row.id);
      await org.retireBot(row.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/bots/:id',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getBot',
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => toBot(await bots.row(request.params.id)),
  );

  app.patch(
    '/bots/:id',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'updateBot',
        description:
          'Identity, mission, models (main, fallbacks, light model for check-ins), check-in rhythm and daily token budget of a bot.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: botUpdateSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await bots.row(request.params.id);
      const body = request.body;
      if (body.name && body.name !== row.name) await bots.moveFolder(row, body.name, files);
      if (body.providerId) {
        const provider = await providers.row(body.providerId);
        // Switching provider without naming a model: take the provider's default.
        if (body.model === undefined) body.model = provider.defaultModel;
      }
      for (const ref of [
        ...(body.fallbacks ?? []),
        ...(body.lightModel ? [body.lightModel] : []),
      ]) {
        await providers.row(ref.providerId);
      }
      const updated = await bots.update(request.params.id, body);
      if (body.heartbeatMinutes !== undefined) {
        await routines.syncHeartbeat(await bots.row(request.params.id));
      }
      return updated;
    },
  );

  app.put(
    '/bots/:id/project',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'setBotProject',
        description:
          'Picks the project the bot works in (a folder shared from your computer that it may use), or none: its `local_*` tools go there when no project is named, and a short note in the conversation tells it.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: botProjectSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => runtime.setProject(request.params.id, request.body.projectId),
  );

  app.get(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listMessages',
        description: 'Conversation with the bot, newest page first (items are oldest → newest).',
        security: bearerSecurity,
        params: botIdParamsSchema,
        querystring: messageListQuerySchema,
        response: { 200: messageListSchema, ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      const { before, limit } = request.query;
      let cursor: Date | null = null;
      if (before) {
        cursor = new Date(before);
        if (Number.isNaN(cursor.getTime()))
          throw new HttpProblem(400, 'invalid_cursor', 'Bad cursor');
      }
      const rows = await db
        .select()
        .from(messages)
        .where(
          cursor
            ? and(eq(messages.botId, request.params.id), lt(messages.createdAt, cursor))
            : eq(messages.botId, request.params.id),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).reverse();
      const oldest = page[0];
      return {
        items: page.map(toMessage),
        nextCursor: rows.length > limit && oldest ? oldest.createdAt.toISOString() : null,
      };
    },
  );

  app.post(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'sendMessage',
        description:
          'Posts a message to the bot, with files of its workspace attached if any (see `uploadAttachments`). Its answer streams through `message.delta` / `message.updated` events.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: sendMessageSchema,
        response: { 202: messageSchema, ...errorResponses },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await runtime.send(
            request.params.id,
            request.body.text,
            request.body.mentions,
            request.body.attachments,
          ),
        ),
  );

  app.post(
    '/bots/:id/attachments',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'uploadAttachments',
        description:
          "multipart/form-data, one or more `file` parts (10 at most, 100 MB each), stored in the `inbox/` folder of the bot's workspace (`name (n).ext` when taken). Then send them with a message as `attachments`.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: attachmentUploadSchema, ...errorResponses },
      },
    },
    async (request) => {
      const workspaceId = workspaceOf(await bots.row(request.params.id));
      if (!request.isMultipart()) {
        throw new HttpProblem(415, 'unsupported_media_type', 'Expected multipart/form-data');
      }
      await files.ensureDir(workspaceId, INBOX);
      const entries: FileEntry[] = [];
      for await (const part of request.files({
        limits: { fileSize: ATTACHMENT_MAX_BYTES, files: MAX_ATTACHMENTS },
      })) {
        entries.push(await files.write(workspaceId, INBOX, part.filename, part.file));
      }
      if (entries.length > 0) {
        events.publish({ type: 'workspace.changed', workspaceId, paths: [INBOX] });
      }
      return { items: entries.map((entry) => toAttachment(workspaceId, entry)) };
    },
  );

  app.post(
    '/bots/:id/messages/voice',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'sendVoiceMessage',
        description:
          "multipart/form-data: the recording as `file` (webm, m4a, ogg, mp3, wav…, 25 MB at most), and optionally `durationMs` and `peaks` (waveform bars, 0–1, comma-separated). Stored in `inbox/voice/` of the bot's workspace and shown at once; the hub transcribes it (`message.updated`), then the bot answers what was said.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 202: messageSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const bot = await bots.row(request.params.id);
      const workspaceId = workspaceOf(bot);
      if (!request.isMultipart()) {
        throw new HttpProblem(415, 'unsupported_media_type', 'Expected multipart/form-data');
      }
      const fields: Record<string, string> = {};
      let stored: FileEntry | null = null;
      for await (const part of request.parts({
        limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 5 },
      })) {
        if (part.type === 'field') {
          fields[part.fieldname] = String(part.value);
          continue;
        }
        const ext = voiceExtension(part.mimetype, part.filename);
        if (!ext) {
          part.file.resume();
          throw new HttpProblem(415, 'unsupported_audio', 'Not a recording this hub can read');
        }
        const dir = await files.ensureDir(workspaceId, `${INBOX}/voice`);
        const name = `${voiceName(new Date(), routines.timeZone)}${ext}`;
        stored = await files.write(workspaceId, dir, name, part.file);
      }
      if (!stored) throw new HttpProblem(400, 'missing_file', 'Send the recording as `file`');
      const parsed = voiceFieldsSchema.safeParse(fields);
      const voice = parsed.success ? parsed.data : {};
      events.publish({ type: 'workspace.changed', workspaceId, paths: [`${INBOX}/voice`] });
      const message = await runtime.sendVoice(bot.id, {
        workspaceId,
        path: stored.path,
        mimeType: audioTypeOf(stored.name),
        durationMs: voice.durationMs ?? 0,
        peaks: parsePeaks(voice.peaks) ?? [],
      });
      return reply.code(202).send(message);
    },
  );

  app.post(
    '/bots/:id/messages/:messageId/transcribe',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'retryTranscript',
        description:
          'Transcribes again a voice message the bot could not hear (failed, or nothing heard). Once done, the bot answers it; if the conversation went on since, it moves to its end.',
        security: bearerSecurity,
        params: messagePressParamsSchema,
        response: { 202: messageSchema, ...errorResponses },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(await runtime.retryTranscript(request.params.id, request.params.messageId)),
  );

  app.post(
    '/bots/:id/messages/:messageId/press',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'pressMessageCard',
        description:
          'Presses a button of a card the bot showed in that message: its reply reaches the bot as your answer (once per card). Buttons that only open a link are opened by the app itself.',
        security: bearerSecurity,
        params: messagePressParamsSchema,
        body: messagePressSchema,
        response: { 200: messageSchema, ...errorResponses },
      },
    },
    async (request) =>
      runtime.pressCard(
        request.params.id,
        request.params.messageId,
        request.body.part,
        request.body.button,
      ),
  );

  app.post(
    '/bots/:id/messages/:messageId/vault-request',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'answerVaultRequest',
        description:
          'Answers a vault request the bot showed in that message: the values go straight into the vault (the bot only learns the reference), or `declined: true`.',
        security: bearerSecurity,
        params: messagePressParamsSchema,
        body: vaultRequestAnswerSchema,
        response: { 200: messageSchema, ...errorResponses },
      },
    },
    async (request) =>
      runtime.answerVaultRequest(request.params.id, request.params.messageId, request.body),
  );

  app.delete(
    '/bots/:id/messages',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'clearMessages',
        description:
          'Starts the conversation over: stops the bot, deletes its messages and closes what it left open on its computer. Workspace files are kept.',
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await runtime.clear(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/bots/:id/stop',
    {
      preHandler: requireAuth('chat'),
      schema: {
        tags,
        operationId: 'stopBot',
        description: "Interrupts the bot's current run.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: z.object({ stopped: z.boolean() }), ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      return { stopped: runtime.stop(request.params.id) };
    },
  );

  app.post(
    '/bots/:id/move',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'moveBot',
        description:
          "Moves a bot to another team (teamId null: solo), on the team's PC or a dedicated one. The bot stops, tidies its old computer up, and its folder follows it to the new workspace. Not the Chef.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        body: botMoveSchema,
        response: { 200: botSchema, ...errorResponses },
      },
    },
    async (request) => runtime.moveBot(request.params.id, request.body),
  );

  app.get(
    '/bots/:id/browser',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getBotBrowser',
        description:
          "What the bot's own Chrome window shows now (a JPEG capture), for a live view. Poll it.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 200: botBrowserSchema, ...errorResponses },
      },
    },
    async (request) => {
      await bots.row(request.params.id);
      return runtime.browser.view(request.params.id);
    },
  );

  app.post(
    '/bots/:id/browser/front',
    {
      preHandler: requireAuth('control'),
      schema: {
        tags,
        operationId: 'showBotBrowser',
        description:
          "Puts the bot's Chrome window in front on its computer's screen, e.g. before taking over.",
        security: bearerSecurity,
        params: botIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await bots.row(request.params.id);
      if (!(await runtime.browser.front(request.params.id))) {
        throw new HttpProblem(409, 'no_page', 'This bot has no page open.');
      }
      return reply.code(204).send(null);
    },
  );
};
