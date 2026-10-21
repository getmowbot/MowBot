import type { Task } from '@mowbot/contract';

/** Longest focus a bot keeps: a sentence, not a report. */
export const FOCUS_MAX = 100;

/** A focus as it is kept: one line, cut; null when there is nothing to say. */
export function cleanFocus(text: string | null | undefined): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > FOCUS_MAX ? `${line.slice(0, FOCUS_MAX - 1).trimEnd()}…` : line;
}

type DoingTask = Pick<Task, 'id' | 'title' | 'status' | 'assigneeBotId' | 'updatedAt'>;

/**
 * The tasks each bot is doing (status `doing`), kept from the task events: what a bot works on
 * when it did not say it itself.
 */
export class DoingTasks {
  private readonly byBot = new Map<string, Map<string, { title: string; at: number }>>();

  /** The title of the task the bot took up last. */
  titleOf(botId: string): string | null {
    let latest: { title: string; at: number } | null = null;
    for (const task of this.byBot.get(botId)?.values() ?? []) {
      if (!latest || task.at >= latest.at) latest = task;
    }
    return latest?.title ?? null;
  }

  /** Takes a task as it is now; returns the bots whose tasks changed. */
  take(task: DoingTask): string[] {
    const touched = new Set<string>();
    for (const [botId, doing] of this.byBot) {
      if (doing.delete(task.id)) touched.add(botId);
      if (doing.size === 0) this.byBot.delete(botId);
    }
    if (task.status === 'doing') {
      const doing = this.byBot.get(task.assigneeBotId) ?? new Map();
      doing.set(task.id, { title: task.title, at: Date.parse(task.updatedAt) });
      this.byBot.set(task.assigneeBotId, doing);
      touched.add(task.assigneeBotId);
    }
    return [...touched];
  }

  forget(botId: string): void {
    this.byBot.delete(botId);
  }
}
