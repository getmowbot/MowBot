import {
  computerIdParamsSchema,
  computerSiteListSchema,
  vaultEventListSchema,
  vaultGrantParamsSchema,
  vaultItemCreateSchema,
  vaultItemIdParamsSchema,
  vaultItemListSchema,
  vaultItemSchema,
  vaultItemUpdateSchema,
  vaultSessionCaptureSchema,
} from '@mowbot/contract';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { bearerSecurity, requireAuth } from '../http/auth-hook';
import { errorResponses } from '../http/problems';

const tags = ['vault'];

/**
 * The vault: browser sessions, logins and secrets for the bots. Values go in (masked fields,
 * captures from a computer) and never come back out.
 */
export const vaultRoutes: FastifyPluginAsyncZod = async (app) => {
  const { vault } = app.services;

  app.get(
    '/vault/items',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listVaultItems',
        description: 'Every entry, without its values.',
        security: bearerSecurity,
        response: { 200: vaultItemListSchema, ...errorResponses },
      },
    },
    async () => ({ items: await vault.list() }),
  );

  app.post(
    '/vault/items',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'createVaultItem',
        description: 'Stores a login (username, password, 2FA seed) or a secret.',
        security: bearerSecurity,
        body: vaultItemCreateSchema,
        response: { 201: vaultItemSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await vault.create(request.body)),
  );

  app.patch(
    '/vault/items/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'updateVaultItem',
        description:
          'Changes labels and policy; replaces values when given (null removes a login field).',
        security: bearerSecurity,
        params: vaultItemIdParamsSchema,
        body: vaultItemUpdateSchema,
        response: { 200: vaultItemSchema, ...errorResponses },
      },
    },
    async (request) => vault.update(request.params.id, request.body),
  );

  app.delete(
    '/vault/items/:id',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'deleteVaultItem',
        security: bearerSecurity,
        params: vaultItemIdParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      await vault.remove(request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/vault/items/:id/events',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listVaultEvents',
        description: 'History of the entry, newest first: captures, uses, requests, decisions.',
        security: bearerSecurity,
        params: vaultItemIdParamsSchema,
        response: { 200: vaultEventListSchema, ...errorResponses },
      },
    },
    async (request) => ({ items: await vault.history(request.params.id) }),
  );

  app.delete(
    '/vault/items/:id/grants/:botId',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'revokeVaultGrant',
        description: 'Takes back the permission given to a bot for an `ask` entry.',
        security: bearerSecurity,
        params: vaultGrantParamsSchema,
        response: { 200: vaultItemSchema, ...errorResponses },
      },
    },
    async (request) => vault.revoke(request.params.id, request.params.botId),
  );

  app.post(
    '/vault/sessions',
    {
      preHandler: requireAuth('admin'),
      schema: {
        tags,
        operationId: 'captureVaultSession',
        description:
          "Saves (or refreshes) a site's session from a running computer's Chrome: its cookies and the local storage of its open pages.",
        security: bearerSecurity,
        body: vaultSessionCaptureSchema,
        response: { 200: vaultItemSchema, ...errorResponses },
      },
    },
    async (request) => vault.capture(request.body),
  );

  app.get(
    '/computers/:id/sites',
    {
      preHandler: requireAuth('read'),
      schema: {
        tags,
        operationId: 'listComputerSites',
        description:
          "Sites with cookies in a running computer's Chrome, to pick a session to save.",
        security: bearerSecurity,
        params: computerIdParamsSchema,
        response: { 200: computerSiteListSchema, ...errorResponses },
      },
    },
    async (request) => ({ items: await vault.sitesOn(request.params.id) }),
  );
};
