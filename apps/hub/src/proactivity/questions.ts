import type { Question } from '@mowbot/contract';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { questions } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';
import { hubTexts } from '../i18n';
import type { NotificationService } from './notifications';

/** Open questions a bot may have at once: more is nagging. */
export const MAX_OPEN_QUESTIONS = 3;

type QuestionRow = typeof questions.$inferSelect;

export function toQuestion(row: QuestionRow): Question {
  return {
    id: row.id,
    botId: row.botId,
    question: row.question,
    options: row.options,
    details: row.details ?? null,
    image: row.image ?? null,
    link: row.link ?? null,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Questions bots ask the user. The user answers with a button (or their own words) in the chat
 * or on the home page; the answer reaches the bot as a message.
 */
export class QuestionService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly notifications: NotificationService,
  ) {}

  async list(filter: { open: boolean; botId?: string }): Promise<Question[]> {
    const rows = await this.db
      .select()
      .from(questions)
      .where(
        and(
          filter.open ? eq(questions.status, 'open') : undefined,
          filter.botId ? eq(questions.botId, filter.botId) : undefined,
        ),
      )
      .orderBy(desc(questions.createdAt))
      .limit(100);
    return rows.map(toQuestion);
  }

  async row(id: string): Promise<QuestionRow> {
    const [row] = await this.db.select().from(questions).where(eq(questions.id, id));
    if (!row) throw notFound('Question not found');
    return row;
  }

  async ask(
    bot: { id: string; name: string },
    question: string,
    options: string[],
    about: {
      vaultItemId?: string;
      projectCommand?: { projectId: string; command: string };
      /** What helps decide, shown with the question. */
      details?: string;
      image?: string;
      link?: { label: string; url: string };
    } = {},
  ): Promise<Question> {
    const open = await this.list({ open: true, botId: bot.id });
    if (open.length >= MAX_OPEN_QUESTIONS) {
      throw new Error(
        `Tu as déjà ${open.length} questions sans réponse : attends que l'utilisateur y réponde.`,
      );
    }
    const [row] = await this.db
      .insert(questions)
      .values({
        botId: bot.id,
        question,
        options,
        vaultItemId: about.vaultItemId ?? null,
        projectCommand: about.projectCommand ?? null,
        details: about.details ?? null,
        image: about.image ?? null,
        link: about.link ?? null,
      })
      .returning();
    if (!row) throw new Error('Question insert returned no row');
    const created = toQuestion(row);
    this.events.publish({ type: 'question.updated', question: created });
    await this.notifications.create({
      botId: bot.id,
      priority: 'normal',
      title: (await hubTexts(this.db)).asks(bot.name),
      body: question,
      push: 'needs_you',
    });
    return created;
  }

  /** Records the user's answer; refused once the question is no longer open. */
  async answer(id: string, answer: string): Promise<Question> {
    const [row] = await this.db
      .update(questions)
      .set({ status: 'answered', answer, answeredAt: new Date() })
      .where(and(eq(questions.id, id), eq(questions.status, 'open')))
      .returning();
    if (!row) {
      await this.row(id);
      throw new HttpProblem(409, 'question_closed', 'This question was already answered');
    }
    const answered = toQuestion(row);
    this.events.publish({ type: 'question.updated', question: answered });
    return answered;
  }

  /** The user sets the question aside without answering: the bot is not told. */
  async dismiss(id: string): Promise<Question> {
    const [row] = await this.db
      .update(questions)
      .set({ status: 'closed' })
      .where(and(eq(questions.id, id), eq(questions.status, 'open')))
      .returning();
    if (!row) {
      await this.row(id);
      throw new HttpProblem(409, 'question_closed', 'This question was already answered');
    }
    const closed = toQuestion(row);
    this.events.publish({ type: 'question.updated', question: closed });
    return closed;
  }

  /** The user wrote to the bot (or cleared its conversation): its questions are moot. */
  async closeOpen(botId: string): Promise<void> {
    const rows = await this.db
      .update(questions)
      .set({ status: 'closed' })
      .where(and(eq(questions.botId, botId), eq(questions.status, 'open')))
      .returning();
    for (const row of rows) {
      this.events.publish({ type: 'question.updated', question: toQuestion(row) });
    }
  }
}
