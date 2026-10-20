import type { Bot, Message, MessagePart } from '@mowbot/contract';
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
