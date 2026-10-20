import type { Bot, BotUpdate, Message } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bots, type messages } from '../db/schema';
import type { EventBus } from '../events';
import { notFound } from '../http/problems';

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
    status: row.status,
    statusDetail: row.statusDetail,
    avatarSeed: row.avatarSeed,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    botId: row.botId,
    role: row.role,
    parts: row.parts,
    status: row.status,
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

  async update(id: string, values: BotUpdate | Partial<BotRow>): Promise<Bot> {
    const [row] = await this.db.update(bots).set(values).where(eq(bots.id, id)).returning();
    if (!row) throw notFound('Bot not found');
    const bot = toBot(row);
    this.events.publish({ type: 'bot.updated', bot });
    return bot;
  }
}
