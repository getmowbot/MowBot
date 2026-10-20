import type { LanguageModel } from 'ai';
import { BotRuntime } from './agents/runtime';
import { SessionService } from './auth/sessions';
import { SetupGate } from './auth/setup';
import { type AccessTokens, createAccessTokens } from './auth/tokens';
import { bootstrapOrganization } from './bots/bootstrap';
import { type BotRow, BotService } from './bots/service';
import { type ComputerRuntime, DockerComputerRuntime } from './computers/runtime';
import { ComputerService } from './computers/service';
import type { Config } from './config';
import type { Db } from './db/client';
import { EventBus } from './events';
import { TicketService } from './http/tickets';
import { ProviderService } from './providers/service';
import { WorkspaceFiles } from './workspaces/files';

/** Everything route handlers need, built once at startup (and per test). */
export interface Services {
  config: Config;
  db: Db;
  tokens: AccessTokens;
  sessions: SessionService;
  setup: SetupGate;
  events: EventBus;
  tickets: TicketService;
  files: WorkspaceFiles;
  computers: ComputerService;
  providers: ProviderService;
  bots: BotService;
  runtime: BotRuntime;
}

export interface ServiceOverrides {
  /** Tests replace Docker with a fake runtime. */
  runtime?: ComputerRuntime;
  /** Tests replace LLM providers with scripted models. */
  modelFor?: (bot: BotRow) => LanguageModel | null;
}

export async function createServices(
  config: Config,
  db: Db,
  overrides: ServiceOverrides = {},
): Promise<Services> {
  const tokens = await createAccessTokens(db, config.masterKey, config.accessTokenTtlSec);
  const events = new EventBus();
  const files = new WorkspaceFiles(config.workspacesDir);
  await bootstrapOrganization(db, files, config.masterKey);
  const computers = new ComputerService(
    db,
    overrides.runtime ?? new DockerComputerRuntime(config),
    events,
    config.masterKey,
    { idleMinutes: config.computers.idleMinutes },
  );
  const providers = new ProviderService(db, config.masterKey);
  const bots = new BotService(db, events);
  return {
    config,
    db,
    tokens,
    sessions: new SessionService(db, tokens, config),
    setup: await SetupGate.create(db, config.setupToken),
    events,
    tickets: new TicketService(),
    files,
    computers,
    providers,
    bots,
    runtime: new BotRuntime({
      db,
      events,
      bots,
      providers,
      computers,
      files,
      modelFor: overrides.modelFor,
    }),
  };
}
