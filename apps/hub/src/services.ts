import type { LanguageModel } from 'ai';
import { eq } from 'drizzle-orm';
import { BrowserHub } from './agents/browser';
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
import { bots as botsTable } from './db/schema';
import { EventBus } from './events';
import { TicketService } from './http/tickets';
import { OrgService } from './org/service';
import type { TaskService } from './org/tasks';
import { CanvasService } from './proactivity/canvases';
import { NotificationService, SystemService } from './proactivity/notifications';
import { QuestionService } from './proactivity/questions';
import { RoutineService } from './proactivity/routines';
import { Scheduler } from './proactivity/scheduler';
import { ProviderService } from './providers/service';
import { PushService } from './push/service';
import { VaultService } from './vault/service';
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
  org: OrgService;
  tasks: TaskService;
  runtime: BotRuntime;
  routines: RoutineService;
  notifications: NotificationService;
  system: SystemService;
  scheduler: Scheduler;
  canvases: CanvasService;
  questions: QuestionService;
  vault: VaultService;
  push: PushService;
  /** Main team, its PC, the Chef and its daily summary (at startup and right after setup). */
  bootstrap(): Promise<void>;
}

export interface ServiceOverrides {
  /** Tests replace Docker with a fake runtime. */
  runtime?: ComputerRuntime;
  /** Tests replace LLM providers with scripted models. */
  modelFor?: (bot: BotRow) => LanguageModel | LanguageModel[] | null;
  /** Tests shorten how long a bot waits for another's answer. */
  askTimeoutMs?: number;
  /** Tests catch push notifications instead of sending them. */
  pushFetch?: typeof fetch;
  /** Tests push "finished" right away. */
  finishedPushAfterMs?: number;
}

export async function createServices(
  config: Config,
  db: Db,
  overrides: ServiceOverrides = {},
): Promise<Services> {
  const tokens = await createAccessTokens(db, config.masterKey, config.accessTokenTtlSec);
  const events = new EventBus();
  const files = new WorkspaceFiles(config.workspacesDir);
  const routines = new RoutineService(db, events, config.masterKey, config.timeZone);
  const notifications = new NotificationService(db, events);
  const system = new SystemService(db, events, config.timeZone);
  const canvases = new CanvasService(db, events);
  const questions = new QuestionService(db, events, notifications);
  const push = new PushService(db, system, { url: config.pushUrl, fetch: overrides.pushFetch });
  notifications.setPush(push);
  const bootstrap = async () => {
    await bootstrapOrganization(db, files, config.masterKey);
    const [chef] = await db.select().from(botsTable).where(eq(botsTable.isChef, true));
    if (chef) await routines.ensureDigest(chef);
  };
  await bootstrap();
  const computers = new ComputerService(
    db,
    overrides.runtime ?? new DockerComputerRuntime(config),
    events,
    config.masterKey,
    { idleMinutes: config.computers.idleMinutes },
  );
  const providers = new ProviderService(db, config.masterKey);
  const bots = new BotService(db, events);
  const org = new OrgService(db, files, computers, events, config.masterKey);
  const browser = new BrowserHub();
  const vault = new VaultService({
    db,
    events,
    masterKey: config.masterKey,
    computers,
    browser,
    questions,
    notifications,
  });
  const runtime = new BotRuntime({
    db,
    events,
    bots,
    providers,
    computers,
    files,
    org,
    routines,
    notifications,
    system,
    canvases,
    questions,
    vault,
    browser,
    push,
    finishedPushAfterMs: overrides.finishedPushAfterMs,
    modelFor: overrides.modelFor,
    askTimeoutMs: overrides.askTimeoutMs,
  });
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
    org,
    tasks: runtime.tasks,
    runtime,
    routines,
    notifications,
    system,
    scheduler: new Scheduler({ db, routines, runtime, system, notifications }),
    canvases,
    questions,
    vault,
    push,
    bootstrap,
  };
}
