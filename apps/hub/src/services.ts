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
import { MirrorService } from './connectors/mirror';
import { ConnectorService } from './connectors/service';
import type { Db } from './db/client';
import { bots as botsTable } from './db/schema';
import { EventBus } from './events';
import { TicketService } from './http/tickets';
import { McpService } from './mcp/service';
import { MemoryService } from './memory/service';
import { PlanService } from './org/plans';
import { OrgService } from './org/service';
import type { TaskService } from './org/tasks';
import { PreviewService } from './previews/service';
import { AutomationService } from './proactivity/automations';
import { CanvasService } from './proactivity/canvases';
import { NotificationService, SystemService } from './proactivity/notifications';
import { QuestionService } from './proactivity/questions';
import { RoutineService } from './proactivity/routines';
import { Scheduler } from './proactivity/scheduler';
import { ProviderService } from './providers/service';
import { PushService } from './push/service';
import { VaultService } from './vault/service';
import { type Transcriber, WhisperTranscriber } from './voice/whisper';
import { WebService } from './web/service';
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
  plans: PlanService;
  runtime: BotRuntime;
  routines: RoutineService;
  notifications: NotificationService;
  system: SystemService;
  scheduler: Scheduler;
  canvases: CanvasService;
  questions: QuestionService;
  vault: VaultService;
  push: PushService;
  automations: AutomationService;
  mcp: McpService;
  connectors: ConnectorService;
  previews: PreviewService;
  mirrors: MirrorService;
  /** The bots' web searches and page reads, from the hub. */
  web: WebService;
  /** What the bots know about the user, whichever heard it. */
  memory: MemoryService;
  /** Main team, its PC, the Chef and its daily summary (at startup and right after setup). */
  bootstrap(): Promise<void>;
}

export interface ServiceOverrides {
  /** How the hub fetches web pages for the bots (tests: a fake web). */
  webFetch?: ConstructorParameters<typeof WebService>[2];
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
  /** Tests transcribe voice messages without Whisper (no model download). */
  transcriber?: Transcriber;
  /** Tests move the previews' clock (expiry). */
  previewClock?: () => number;
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
  const web = new WebService(db, config.masterKey, overrides.webFetch);
  const memory = new MemoryService(db, events);
  const canvases = new CanvasService(db, events);
  const questions = new QuestionService(db, events, notifications);
  const push = new PushService(db, system, { url: config.pushUrl, fetch: overrides.pushFetch });
  notifications.setPush(push);
  const bootstrap = async () => {
    await bootstrapOrganization(db, files, config.masterKey);
    const [chef] = await db.select().from(botsTable).where(eq(botsTable.isChef, true));
    if (chef) {
      await routines.ensureDigest(chef);
      await routines.syncWatch(chef, (await system.get()).watch);
    }
  };
  await bootstrap();
  const computers = new ComputerService(
    db,
    overrides.runtime ?? new DockerComputerRuntime(config),
    events,
    config.masterKey,
    { idleMinutes: config.computers.idleMinutes },
  );
  const providers = new ProviderService(db, config.masterKey, config.chatgpt);
  const bots = new BotService(db, events);
  await bots.watchTasks();
  const org = new OrgService(db, files, computers, events, config.masterKey);
  const plans = new PlanService(db, events);
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
  const mcp = new McpService({ db, events, masterKey: config.masterKey, computers, files });
  const connectors = new ConnectorService({ db, events, bots });
  const mirrors = new MirrorService({
    db,
    events,
    files,
    connectors,
    notifications,
    limits: config.mirror,
  });
  const previews = new PreviewService(db, computers, events, config.masterKey, {
    ...config.previews,
    host: config.host,
    trustProxy: config.trustProxy,
    now: overrides.previewClock,
  });
  const automations = new AutomationService({
    db,
    events,
    canvases,
    notifications,
    computers,
    system,
    vault,
  });
  const runtime = new BotRuntime({
    db,
    events,
    bots,
    providers,
    computers,
    files,
    org,
    plans,
    routines,
    notifications,
    system,
    canvases,
    questions,
    vault,
    browser,
    push,
    automations,
    mcp,
    connectors,
    previews,
    mirrors,
    web,
    memory,
    voice: {
      transcriber:
        overrides.transcriber ??
        new WhisperTranscriber({ model: config.voice.model, cacheDir: config.voice.modelsDir }),
      ffmpeg: config.voice.ffmpeg,
      language: config.voice.language,
    },
    finishedPushAfterMs: overrides.finishedPushAfterMs,
    modelFor: overrides.modelFor,
    askTimeoutMs: overrides.askTimeoutMs,
  });
  automations.setRuntime(runtime);
  mirrors.setNote((botId, text, display) => runtime.note(botId, text, display));
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
    plans,
    runtime,
    routines,
    notifications,
    system,
    scheduler: new Scheduler({ db, routines, runtime, system, notifications }),
    canvases,
    questions,
    vault,
    push,
    automations,
    mcp,
    connectors,
    previews,
    mirrors,
    web,
    memory,
    bootstrap,
  };
}
