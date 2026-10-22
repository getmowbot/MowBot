import type { Memory, MemoryCreate, MemoryKind, MemoryUpdate } from '@mowbot/contract';
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memories } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';

type MemoryRow = typeof memories.$inferSelect;

/** At most this many memories: past it, the bots tidy up (forget) before keeping more. */
export const MAX_MEMORIES = 1_000;
/** What every bot reads in its prompt: the facts, and the events of the coming weeks. */
const PROMPT_FACTS = 80;
const PROMPT_EVENTS = 30;
const EVENTS_AHEAD_DAYS = 60;

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  profile: 'profil',
  preference: 'goût',
  event: 'événement',
  note: 'note',
};

export function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    at: row.at?.toISOString() ?? null,
    sourceBotId: row.sourceBotId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const same = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The organisation's memory of the user: what any bot heard that may serve elsewhere (who they
 * are, what they like and use, what is coming). Every bot reads it in its prompt and keeps it up
 * to date; the user sees, fixes and deletes it. Secrets are not kept here (they go to the vault).
 */
export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  async list(): Promise<Memory[]> {
    const rows = await this.db.select().from(memories).orderBy(desc(memories.updatedAt));
    return rows.map(toMemory);
  }

  async get(id: string): Promise<Memory> {
    return toMemory(await this.row(id));
  }

  /**
   * Keeps a fact: the same one again only freshens it; `replaces` updates an older one (an
   * email that changed, a date that moved).
   */
  async remember(
    input: MemoryCreate & { replaces?: string },
    sourceBotId: string | null,
  ): Promise<{ memory: Memory; status: 'new' | 'known' | 'updated' }> {
    const at = input.at ? new Date(input.at) : null;
    if (input.replaces) {
      const updated = await this.update(input.replaces, { ...input, at: input.at ?? null });
      return { memory: updated, status: 'updated' };
    }
    const [known] = (
      await this.db.select().from(memories).where(eq(memories.kind, input.kind))
    ).filter((row) => same(row.text, input.text));
    if (known) {
      const [row] = await this.db
        .update(memories)
        .set({ updatedAt: new Date(), ...(at ? { at } : {}) })
        .where(eq(memories.id, known.id))
        .returning();
      return { memory: this.publish(row ?? known), status: 'known' };
    }
    const [{ total = 0 } = {}] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(memories);
    if (total >= MAX_MEMORIES) {
      throw new HttpProblem(
        409,
        'memory_full',
        `La mémoire garde ${MAX_MEMORIES} souvenirs au plus : oublie ceux qui ne servent plus (forget).`,
      );
    }
    const [row] = await this.db
      .insert(memories)
      .values({ kind: input.kind, text: input.text.trim(), at, sourceBotId })
      .returning();
    if (!row) throw new Error('Memory insert returned no row');
    return { memory: this.publish(row), status: 'new' };
  }

  async update(id: string, input: MemoryUpdate): Promise<Memory> {
    await this.row(id);
    const [row] = await this.db
      .update(memories)
      .set({
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.text ? { text: input.text.trim() } : {}),
        ...(input.at !== undefined ? { at: input.at ? new Date(input.at) : null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(memories.id, id))
      .returning();
    if (!row) throw notFound('Memory not found');
    return this.publish(row);
  }

  async forget(id: string): Promise<void> {
    const gone = await this.db.delete(memories).where(eq(memories.id, id)).returning();
    if (gone.length === 0) throw notFound('Memory not found');
    this.events.publish({ type: 'memory.deleted', memoryId: id });
  }

  /** Memories whose text has every word of `query` (any order, any case). */
  async search(query: string, limit = 20): Promise<Memory[]> {
    const words = query
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 1)
      .slice(0, 6);
    if (words.length === 0) return [];
    const rows = await this.db
      .select()
      .from(memories)
      .where(and(...words.map((word) => ilike(memories.text, `%${word.replace(/[%_]/g, '')}%`))))
      .orderBy(desc(memories.updatedAt))
      .limit(limit);
    return rows.map(toMemory);
  }

  /**
   * What every bot reads of the memory: the facts (newest first), then the events from yesterday
   * to the coming weeks, each with its short id (to replace or forget it).
   */
  async promptLines(now: Date, timeZone: string): Promise<{ facts: string[]; events: string[] }> {
    const facts = await this.db
      .select()
      .from(memories)
      .where(or(isNull(memories.at), sql`${memories.kind} <> 'event'`))
      .orderBy(desc(memories.updatedAt))
      .limit(PROMPT_FACTS);
    const from = new Date(now.getTime() - 24 * 3_600_000);
    const to = new Date(now.getTime() + EVENTS_AHEAD_DAYS * 24 * 3_600_000);
    const events = await this.db
      .select()
      .from(memories)
      .where(and(eq(memories.kind, 'event'), gte(memories.at, from), lte(memories.at, to)))
      .orderBy(asc(memories.at))
      .limit(PROMPT_EVENTS);
    const when = (date: Date) =>
      date.toLocaleString('fr-FR', {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    return {
      facts: facts.map(
        (row) => `- [${row.id.slice(0, 8)}] (${MEMORY_KIND_LABELS[row.kind]}) ${row.text}`,
      ),
      events: events.map(
        (row) => `- [${row.id.slice(0, 8)}] ${row.at ? when(row.at) : ''} : ${row.text}`,
      ),
    };
  }

  /** A memory by its id or its first characters (as bots read them). */
  async resolve(ref: string): Promise<string> {
    const value = ref.trim().replace(/^\[|\]$/g, '');
    const rows = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(sql`${memories.id}::text like ${`${value.toLowerCase()}%`}`)
      .limit(2);
    if (rows.length !== 1 || !rows[0]) {
      throw new Error(`Aucun souvenir « ${value} » (donne son id entre crochets, ex. 3f2a9c1e).`);
    }
    return rows[0].id;
  }

  private publish(row: MemoryRow): Memory {
    const memory = toMemory(row);
    this.events.publish({ type: 'memory.updated', memory });
    return memory;
  }

  private async row(id: string): Promise<MemoryRow> {
    const [row] = await this.db.select().from(memories).where(eq(memories.id, id));
    if (!row) throw notFound('Memory not found');
    return row;
  }
}
