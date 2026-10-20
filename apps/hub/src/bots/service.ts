import type { Bot, BotUpdate, Message, MessagePart } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bots, messages } from '../db/schema';
import type { EventBus } from '../events';
import { notFound } from '../http/problems';
import type { WorkspaceFiles } from '../workspaces/files';

export type BotRow = typeof bots.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export function toBot(row: BotRow): Bot {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    mission: row.mission,
    isChef: row.isChef,
    teamId: row.teamId,
    computerId: row.computerId,
    workspaceId: row.workspaceId,
    providerId: row.providerId,
    model: row.model,
    fallbacks: row.fallbacks,
    lightModel: row.lightModel ?? null,
    heartbeatMinutes: row.heartbeatMinutes,
    dailyTokenBudget: row.dailyTokenBudget,
    status: row.status,
    statusDetail: row.statusDetail,
    avatarSeed: row.avatarSeed,
    managerId: row.managerId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    botId: row.botId,
    role: row.role,
    fromBotId: row.fromBotId,
    fromName: row.meta?.fromName ?? null,
    kind: row.kind,
    taskId: row.meta?.taskId ?? null,
    parts: row.parts,
    status: row.status,
    errorCode: row.errorCode ?? null,
    error: row.error,
    usage: row.usage ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Folder of a bot inside its workspace: `bots/<slug>`. */
export function botFolder(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `bots/${slug || 'bot'}`;
}

export class BotService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  async list(): Promise<Bot[]> {
    const rows = await this.db.select().from(bots).orderBy(bots.createdAt);
    return rows.map(toBot);
  }

  async row(id: string): Promise<BotRow> {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, id));
    if (!row) throw notFound('Bot not found');
    return row;
  }

  /**
   * A renamed bot keeps its workspace folder: `bots/<old>` moves to `bots/<new>` (unless that
   * one exists) and the screenshots shown in its conversation follow.
   */
  async moveFolder(row: BotRow, newName: string, files: WorkspaceFiles): Promise<void> {
    const from = botFolder(row.name);
    const to = botFolder(newName);
    if (from === to || !row.workspaceId) return;
    try {
      await files.move(row.workspaceId, from, to);
    } catch {
      return; // No folder yet, or the new name's folder is taken: each keeps its own.
    }
    const rows = await this.db
      .select({ id: messages.id, parts: messages.parts })
      .from(messages)
      .where(eq(messages.botId, row.id));
    for (const message of rows) {
      let moved = false;
      const parts = message.parts.map((part): MessagePart => {
        if (part.type !== 'tool' || !part.image?.path.startsWith(`${from}/`)) return part;
        moved = true;
        return { ...part, image: { ...part.image, path: to + part.image.path.slice(from.length) } };
      });
      if (moved) await this.db.update(messages).set({ parts }).where(eq(messages.id, message.id));
    }
    this.events.publish({
      type: 'workspace.changed',
      workspaceId: row.workspaceId,
      paths: ['bots'],
    });
  }

  async update(id: string, values: BotUpdate | Partial<BotRow>): Promise<Bot> {
    const [row] = await this.db.update(bots).set(values).where(eq(bots.id, id)).returning();
    if (!row) throw notFound('Bot not found');
    const bot = toBot(row);
    this.events.publish({ type: 'bot.updated', bot });
    return bot;
  }
}
