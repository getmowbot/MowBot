import type { Locale, TaskStatus } from '@mowbot/contract';
import type { Db } from './db/client';
import { owner } from './db/schema';

/** The owner's language: what the apps show and what bots answer in. */
export async function ownerLocale(db: Db): Promise<Locale> {
  const [row] = await db.select({ locale: owner.locale }).from(owner).limit(1);
  return row?.locale ?? 'fr';
}

/** The few texts the hub writes for the user to read (bots' prompts stay in French). */
export const HUB_TEXTS: Record<
  Locale,
  { task: string; taskStatus: Record<TaskStatus, string>; replyIn: string }
> = {
  fr: {
    task: 'Tâche',
    taskStatus: {
      todo: 'à faire',
      doing: 'en cours',
      blocked: 'bloquée',
      done: 'terminée',
      cancelled: 'annulée',
    },
    replyIn: 'en français',
  },
  en: {
    task: 'Task',
    taskStatus: {
      todo: 'to do',
      doing: 'in progress',
      blocked: 'blocked',
      done: 'done',
      cancelled: 'cancelled',
    },
    replyIn: 'en anglais (English)',
  },
};
