import { SessionService } from './auth/sessions';
import { SetupGate } from './auth/setup';
import { type AccessTokens, createAccessTokens } from './auth/tokens';
import type { Config } from './config';
import type { Db } from './db/client';

/** Everything route handlers need, built once at startup (and per test). */
export interface Services {
  config: Config;
  db: Db;
  tokens: AccessTokens;
  sessions: SessionService;
  setup: SetupGate;
}

export async function createServices(config: Config, db: Db): Promise<Services> {
  const tokens = await createAccessTokens(db, config.masterKey, config.accessTokenTtlSec);
  return {
    config,
    db,
    tokens,
    sessions: new SessionService(db, tokens, config),
    setup: await SetupGate.create(db, config.setupToken),
  };
}
