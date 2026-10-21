import path from 'node:path';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MOWBOT_HOST: z.string().default('0.0.0.0'),
  MOWBOT_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** `postgres://…` in production, `pglite://<dir>` (or `pglite://memory`) for local dev without Docker. */
  DATABASE_URL: z.string().min(1).default('pglite://.data/pglite'),
  /** 32 random bytes, base64. Encrypts secrets at rest (JWT signing key today, the vault later). */
  MOWBOT_MASTER_KEY: z.string().min(1, 'MOWBOT_MASTER_KEY is required'),
  /** Optional fixed setup token; a random one is generated and logged when absent. */
  MOWBOT_SETUP_TOKEN: z.string().min(16).optional(),
  /** Comma-separated origins allowed by CORS (the web app in dev, native clients do not need it). */
  MOWBOT_CORS_ORIGINS: z.string().default(''),
  MOWBOT_COOKIE_SECURE: booleanString.optional(),
  MOWBOT_TRUST_PROXY: booleanString.default(false),
  /** Where the hub reads and writes workspace files. */
  MOWBOT_WORKSPACES_DIR: z.string().default('.data/workspaces'),
  /**
   * Named Docker volume holding MOWBOT_WORKSPACES_DIR when the hub runs in Docker: computers
   * then mount `<volume>/<workspaceId>`. Unset: computers bind-mount the host directory.
   */
  MOWBOT_WORKSPACES_VOLUME: z.string().optional(),
  MOWBOT_WORKSTATION_IMAGE: z.string().default('mowbot/workstation:local'),
  MOWBOT_COMPUTER_NETWORK: z.string().default('mowbot-computers'),
  /** `dns`: hub shares the computers' network. `host-port`: hub runs on the host (dev). */
  MOWBOT_COMPUTER_REACH: z.enum(['dns', 'host-port']).default('host-port'),
  /** Optional OCI runtime for computers, e.g. `sysbox-runc`. */
  MOWBOT_COMPUTER_RUNTIME: z.string().optional(),
  /** Stop computers nobody used for this long. 0 disables hibernation. */
  MOWBOT_COMPUTER_IDLE_MINUTES: z.coerce.number().int().min(0).default(30),
  /** Routines, quiet hours and "today" are in this time zone. */
  MOWBOT_TIME_ZONE: z.string().default('Europe/Paris'),
  /** Where push notifications go (Expo's push service, which relays to Apple and Google). */
  MOWBOT_PUSH_URL: z.url().default('https://exp.host/--/api/v2/push/send'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  logLevel: string;
  host: string;
  port: number;
  databaseUrl: string;
  masterKey: Buffer;
  setupToken: string | undefined;
  corsOrigins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  /** A refresh token reused within this window is treated as a client race, not as theft. */
  refreshReuseGraceSec: number;
  workspacesDir: string;
  workspacesVolume: string | undefined;
  computers: {
    image: string;
    network: string;
    reach: 'dns' | 'host-port';
    runtime: string | undefined;
    idleMinutes: number;
  };
  timeZone: string;
  pushUrl: string;
}

export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'MOWBOT_MASTER_KEY must be 32 bytes encoded in base64. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Compose passes unset optional variables as empty strings: treat them as absent.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${issues.join('\n')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.MOWBOT_HOST,
    port: e.MOWBOT_PORT,
    databaseUrl: e.DATABASE_URL,
    masterKey: parseMasterKey(e.MOWBOT_MASTER_KEY),
    setupToken: e.MOWBOT_SETUP_TOKEN,
    corsOrigins: e.MOWBOT_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    cookieSecure: e.MOWBOT_COOKIE_SECURE ?? e.NODE_ENV === 'production',
    trustProxy: e.MOWBOT_TRUST_PROXY,
    accessTokenTtlSec: 10 * 60,
    refreshTokenTtlSec: 30 * 24 * 60 * 60,
    refreshReuseGraceSec: 10,
    workspacesDir: path.resolve(e.MOWBOT_WORKSPACES_DIR),
    workspacesVolume: e.MOWBOT_WORKSPACES_VOLUME,
    computers: {
      image: e.MOWBOT_WORKSTATION_IMAGE,
      network: e.MOWBOT_COMPUTER_NETWORK,
      reach: e.MOWBOT_COMPUTER_REACH,
      runtime: e.MOWBOT_COMPUTER_RUNTIME,
      idleMinutes: e.MOWBOT_COMPUTER_IDLE_MINUTES,
    },
    timeZone: e.MOWBOT_TIME_ZONE,
    pushUrl: e.MOWBOT_PUSH_URL,
  };
}
