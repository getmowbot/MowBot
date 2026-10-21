import type {
  Automation,
  Bot,
  Connector,
  McpCall,
  McpServer,
  Message,
  MessagePart,
  Project,
  VaultEvent,
  VaultItem,
} from '@mowbot/contract';
import i18next, { type TFunction } from 'i18next';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';

let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

export function message(overrides: Partial<Message> = {}): Message {
  return {
    id: uuid(),
    botId: 'bot-1',
    role: 'assistant',
    fromBotId: null,
    fromName: null,
    kind: 'chat',
    taskId: null,
    parts: [],
    steered: false,
    stepLimit: false,
    mentions: [],
    status: 'done',
    errorCode: null,
    error: null,
    usage: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function tool(
  toolName: string,
  input: Record<string, unknown> = {},
  state: 'running' | 'done' | 'error' = 'done',
): Extract<MessagePart, { type: 'tool' }> {
  return { type: 'tool', toolCallId: uuid(), toolName, input, state };
}

export function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: uuid(),
    name: 'Nova',
    role: 'Veille',
    mission: null,
    isChef: false,
    teamId: null,
    managerId: null,
    computerId: null,
    workspaceId: null,
    providerId: null,
    model: null,
    fallbacks: [],
    lightModel: null,
    heartbeatMinutes: null,
    dailyTokenBudget: null,
    status: 'idle',
    statusDetail: null,
    avatarSeed: 'nova',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

export function vaultItem(overrides: Partial<VaultItem> = {}): VaultItem {
  const id = uuid();
  return {
    id,
    ref: id.slice(0, 8),
    kind: 'login',
    service: 'Google',
    account: null,
    sites: [],
    notes: null,
    policy: 'auto',
    fields: ['username', 'password'],
    computerId: null,
    createdByBotId: null,
    session: null,
    grantedBotIds: [],
    capturedAt: null,
    lastUsedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function vaultEvent(overrides: Partial<VaultEvent> = {}): VaultEvent {
  return {
    id: uuid(),
    itemId: 'item-1',
    action: 'used',
    botId: null,
    computerId: null,
    detail: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: uuid(),
    botId: 'bot-1',
    name: 'Score PSG',
    command: 'python3 score.py',
    intervalSeconds: 30,
    canvasId: null,
    until: null,
    status: 'active',
    runs: 0,
    failures: 0,
    lastRunAt: null,
    lastOutcome: null,
    stop: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function mcpServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: uuid(),
    name: 'GitHub',
    slug: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    command: null,
    auth: 'none',
    secretKeys: [],
    scope: { kind: 'all', ids: [] },
    computerId: null,
    createdByBotId: null,
    enabled: true,
    status: 'ok',
    statusDetail: null,
    tools: [],
    toolsAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function mcpCall(overrides: Partial<McpCall> = {}): McpCall {
  return {
    id: uuid(),
    serverId: 'server-1',
    botId: null,
    tool: 'search_issues',
    ok: true,
    durationMs: 120,
    error: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: uuid(),
    name: 'PC-de-Joris',
    hostname: 'PC-de-Joris',
    os: 'windows',
    shell: 'powershell',
    version: '0.1.0',
    online: true,
    lastSeenAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: uuid(),
    connectorId: 'connector-1',
    key: 'b6c1d2e3-0000-4000-8000-000000000000',
    name: 'MowBot',
    path: 'C:\\Users\\Joris\\projects\\MowBot',
    mode: 'ask',
    scope: { kind: 'all', ids: [] },
    online: true,
    createdAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 20, 12, 0, sequence)).toISOString(),
    ...overrides,
  };
}

/** A real i18next instance on the app's catalogs (no React, no native modules). */
export async function translator(language: 'fr' | 'en'): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({
    resources: { fr: { translation: fr }, en: { translation: en } },
    lng: language,
    fallbackLng: 'fr',
    interpolation: { escapeValue: false },
  });
  return instance.t;
}
