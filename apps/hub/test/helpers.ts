import { randomBytes } from 'node:crypto';
import type { TokenResponse } from '@mowbot/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { type Database, openDatabase } from '../src/db/client';
import { createServices, type Services } from '../src/services';

export const SETUP_TOKEN = 'test-setup-token-0123456789';
export const PASSWORD = 'correct horse battery staple';

export interface TestApp {
  app: FastifyInstance;
  services: Services;
  close(): Promise<void>;
}

/** A hub backed by an in-memory PGlite database, freshly migrated. */
export async function createTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const config: Config = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      MOWBOT_MASTER_KEY: randomBytes(32).toString('base64'),
      MOWBOT_SETUP_TOKEN: SETUP_TOKEN,
    }),
    ...overrides,
  };
  const database: Database = await openDatabase(config.databaseUrl);
  await database.migrate();
  const services = await createServices(config, database.db);
  const app = await buildApp(services);
  await app.ready();
  return {
    app,
    services,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}

export async function setupOwner(
  app: FastifyInstance,
  device: { name: string; kind: 'web' | 'ios' | 'cli' } = { name: 'CLI', kind: 'cli' },
): Promise<TokenResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { setupToken: SETUP_TOKEN, displayName: 'Joris', password: PASSWORD, device },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return res.json();
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
