import {
  mcpCallListSchema,
  mcpComputerSchema,
  mcpOAuthStartResultSchema,
  mcpOAuthStartSchema,
  mcpServerCreateSchema,
  mcpServerIdParamsSchema,
  mcpServerListSchema,
  mcpServerSchema,
  mcpServerUpdateSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';
import { hubTexts } from '../i18n';
import { toMcpServer } from '../mcp/service';

const tags = ['mcp'];

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page the browser lands on after signing in to an MCP server. */
const landing = (lang: string, title: string, text: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MowBot</title><style>body{font-family:system-ui,sans-serif;background:#06070a;color:#f3f4f6;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem}p{color:#9ca3af}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`;

/** MCP servers: tools from elsewhere for the bots (remote, or run on the MCP computer). */
export const mcpRoutes: FastifyPluginAsyncZod = async (app) => {
  const { mcp } = app.services;
  /** Connects and lists tools in the background (a local server may take a while to start). */
  const refreshLater = (id: string) => {
    void mcp.refresh(id).catch(() => undefined);
  };

  app.get(
    '/mcp/servers',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listMcpServers',
        security: bearerSecurity,
        response: { 200: mcpServerListSchema, ...errorResponses },
      },
    },
    async () => ({ items: (await mcp.list()).map(toMcpServer) }),
  );

  app.post(
    '/mcp/servers',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'createMcpServer',
        description:
          'Adds a server. Its tools are listed in the background (follow `mcp.updated`); an OAuth server first needs `oauth/start`.',
        security: bearerSecurity,
        body: mcpServerCreateSchema,
        response: { 201: mcpServerSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const row = await mcp.create(request.body);
      if (row.auth !== 'oauth') refreshLater(row.id);
      return reply.code(201).send(toMcpServer(row));
    },
  );

  app.patch(
    '/mcp/servers/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'updateMcpServer',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        body: mcpServerUpdateSchema,
        response: { 200: mcpServerSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await mcp.update(request.params.id, request.body);
      if (row.status === 'unknown' && row.enabled && row.auth !== 'oauth') refreshLater(row.id);
      return toMcpServer(row);
    },
  );

  app.delete(
    '/mcp/servers/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'deleteMcpServer',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await mcp.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/mcp/servers/:id/refresh',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'refreshMcpServer',
        description:
          'Connects again and lists the tools (a local server starts on the MCP computer, which starts if it sleeps).',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        response: { 200: mcpServerSchema, ...errorResponses },
      },
    },
    async (request) => toMcpServer(await mcp.refresh(request.params.id)),
  );

  app.post(
    '/mcp/servers/:id/move',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'moveMcpServer',
        description:
          'Moves a local server a bot installed on its own computer (`computerId` set) to the MCP computer. The bots that had it keep it (a scope of all bots becomes that computer’s team, or its bots). Its tools are listed again in the background; a server installed by hand (pipx, pip…) must be installed on the MCP computer first.',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        response: { 200: mcpServerSchema, ...errorResponses },
      },
    },
    async (request) => {
      const row = await mcp.moveToMcpComputer(request.params.id);
      if (row.enabled) refreshLater(row.id);
      return toMcpServer(row);
    },
  );

  app.get(
    '/mcp/computer',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'getMcpComputer',
        description:
          'The computer local servers run on. It starts when one is needed and sleeps when idle (follow `mcp.computer`).',
        security: bearerSecurity,
        response: { 200: mcpComputerSchema, ...errorResponses },
      },
    },
    async () => mcp.computerState(),
  );

  app.post(
    '/mcp/computer/start',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'startMcpComputer',
        description: 'Starts the MCP computer in the background (status `starting`).',
        security: bearerSecurity,
        response: { 200: mcpComputerSchema, ...errorResponses },
      },
    },
    async () => mcp.startComputer(),
  );

  app.post(
    '/mcp/computer/stop',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'stopMcpComputer',
        description:
          'Puts the MCP computer to sleep: its servers stop and start again on their next use. Its home (installs, sign-ins) is kept.',
        security: bearerSecurity,
        response: { 200: mcpComputerSchema, ...errorResponses },
      },
    },
    async () => mcp.stopComputer(),
  );

  app.post(
    '/mcp/servers/:id/oauth/start',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'startMcpOAuth',
        description:
          'Starts signing in to the server: open `authorizationUrl` in the browser; it comes back to `<redirectBase>/api/v1/mcp/oauth/callback`.',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        body: mcpOAuthStartSchema,
        response: { 200: mcpOAuthStartResultSchema, ...errorResponses },
      },
    },
    async (request) => ({
      authorizationUrl: await mcp.oauthStart(request.params.id, request.body.redirectBase),
    }),
  );

  // Public: the authorization server sends the browser here; the state ties it to a server.
  app.get(
    '/mcp/oauth/callback',
    {
      schema: {
        hide: true,
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { code, state, error, error_description } = request.query;
      const texts = (await hubTexts(app.services.db)).mcpSignIn;
      reply.type('text/html; charset=utf-8');
      if (error || !code || !state) {
        return landing(texts.lang, texts.refused, error_description ?? error ?? texts.incomplete);
      }
      try {
        const row = await mcp.oauthFinish(state, code);
        return landing(texts.lang, texts.connected(row.name), texts.connectedBody);
      } catch (caught) {
        reply.code(400);
        return landing(texts.lang, texts.failed, (caught as Error).message);
      }
    },
  );

  app.get(
    '/mcp/servers/:id/calls',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listMcpCalls',
        description: 'The latest calls bots made to this server, newest first.',
        security: bearerSecurity,
        params: mcpServerIdParamsSchema,
        response: { 200: mcpCallListSchema, ...errorResponses },
      },
    },
    async (request) => ({ items: await mcp.calls(request.params.id) }),
  );
};
