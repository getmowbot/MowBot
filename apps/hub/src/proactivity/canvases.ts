import { randomBytes } from 'node:crypto';
import type { Canvas, CanvasContent, CanvasSize } from '@mowbot/contract';
import { and, asc, count, eq, max } from 'drizzle-orm';
import type { Db } from '../db/client';
import { canvases } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';

/** Keeps the home page readable. */
export const MAX_CANVASES_PER_BOT = 4;
export const MAX_CANVASES = 24;

type CanvasRow = typeof canvases.$inferSelect;
type ChecklistContent = Extract<CanvasContent, { kind: 'checklist' }>;

export function toCanvas(row: CanvasRow): Canvas {
  return {
    id: row.id,
    botId: row.botId,
    key: row.key,
    title: row.title,
    size: row.size,
    content: row.content,
    position: row.position,
    hidden: row.hidden,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const newItemId = () => randomBytes(6).toString('base64url');

/** The home page: bots publish canvases, the user arranges (or removes) them. */
export class CanvasService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  async list(botId?: string): Promise<CanvasRow[]> {
    return this.db
      .select()
      .from(canvases)
      .where(botId ? eq(canvases.botId, botId) : undefined)
      .orderBy(asc(canvases.position), asc(canvases.createdAt));
  }

  async row(id: string): Promise<CanvasRow> {
    const [row] = await this.db.select().from(canvases).where(eq(canvases.id, id));
    if (!row) throw notFound('Canvas not found');
    return row;
  }

  async byKey(botId: string, key: string): Promise<CanvasRow | undefined> {
    const [row] = await this.db
      .select()
      .from(canvases)
      .where(and(eq(canvases.botId, botId), eq(canvases.key, key)));
    return row;
  }

  private publish(row: CanvasRow): Canvas {
    const canvas = toCanvas(row);
    this.events.publish({ type: 'canvas.updated', canvas });
    return canvas;
  }

  /**
   * A bot creates its canvas, or updates the one with the same key (that's the normal way: one
   * card that stays current, not a new card each time). A canvas the user hid stays hidden.
   */
  async publishFromBot(
    botId: string,
    input: { key: string; title: string; size?: CanvasSize; content: CanvasContent },
  ): Promise<{ canvas: Canvas; created: boolean }> {
    const existing = await this.byKey(botId, input.key);
    if (existing) {
      const [row] = await this.db
        .update(canvases)
        .set({
          title: input.title,
          content: input.content,
          ...(input.size ? { size: input.size } : {}),
          updatedAt: new Date(),
        })
        .where(eq(canvases.id, existing.id))
        .returning();
      if (!row) throw notFound('Canvas not found');
      return { canvas: this.publish(row), created: false };
    }
    const [{ mine = 0 } = {}] = await this.db
      .select({ mine: count() })
      .from(canvases)
      .where(eq(canvases.botId, botId));
    if (mine >= MAX_CANVASES_PER_BOT) {
      throw new HttpProblem(
        409,
        'too_many_canvases',
        `Tu as déjà ${MAX_CANVASES_PER_BOT} canvas : mets à jour ou retire l'un d'eux (canvas_list).`,
      );
    }
    const [{ total = 0, last = 0 } = {}] = await this.db
      .select({ total: count(), last: max(canvases.position) })
      .from(canvases);
    if (total >= MAX_CANVASES) {
      throw new HttpProblem(
        409,
        'too_many_canvases',
        "La page d'accueil est pleine : mets à jour un de tes canvas plutôt que d'en créer.",
      );
    }
    const [row] = await this.db
      .insert(canvases)
      .values({
        botId,
        key: input.key,
        title: input.title,
        size: input.size ?? 's',
        content: input.content,
        position: (last ?? 0) + 1,
      })
      .returning();
    if (!row) throw new Error('Canvas insert returned no row');
    return { canvas: this.publish(row), created: true };
  }

  /** Layout and visibility, by the user. */
  async update(id: string, input: { size?: CanvasSize; hidden?: boolean }): Promise<Canvas> {
    await this.row(id);
    const [row] = await this.db
      .update(canvases)
      .set({
        ...(input.size ? { size: input.size } : {}),
        ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      })
      .where(eq(canvases.id, id))
      .returning();
    if (!row) throw notFound('Canvas not found');
    return this.publish(row);
  }

  /** The user's order on the home page (ids not given keep their place after these). */
  async reorder(ids: string[]): Promise<void> {
    const rows = await this.list();
    const rest = rows.filter((row) => !ids.includes(row.id)).map((row) => row.id);
    const order = [...ids.filter((id) => rows.some((row) => row.id === id)), ...rest];
    for (const [position, id] of order.entries()) {
      const [row] = await this.db
        .update(canvases)
        .set({ position })
        .where(eq(canvases.id, id))
        .returning();
      if (row) this.publish(row);
    }
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(canvases).where(eq(canvases.id, id));
    this.events.publish({ type: 'canvas.deleted', canvasId: id });
  }

  /** Changes the items of a checklist canvas (ticks, additions, removals by the user). */
  async editChecklist(
    id: string,
    change: (items: ChecklistContent['items']) => ChecklistContent['items'],
  ): Promise<Canvas> {
    const row = await this.row(id);
    if (row.content.kind !== 'checklist') {
      throw new HttpProblem(400, 'not_a_checklist', 'This canvas is not a checklist');
    }
    const items = change(row.content.items);
    if (items.length > 60) throw new HttpProblem(400, 'too_many_items', 'At most 60 items');
    const [updated] = await this.db
      .update(canvases)
      .set({ content: { kind: 'checklist', items }, updatedAt: new Date() })
      .where(eq(canvases.id, id))
      .returning();
    if (!updated) throw notFound('Canvas not found');
    return this.publish(updated);
  }
}
