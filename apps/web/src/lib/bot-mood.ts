import type { Bot, Message } from '@mowbot/contract';
import { actionTitle } from '../components/activity';
import type { BotMood } from '../components/bot-avatar';
import { i18n } from '../i18n';

/** The answer the bot is writing, when the conversation is open: it knows first what runs. */
type Live = Pick<Message, 'parts'> | undefined;

/** The tool call the bot is running now (from its answer under way, else from the hub), if any. */
export function currentAction(
  bot: Pick<Bot, 'status' | 'activity'>,
  live?: Live,
): { toolName: string; input: unknown } | null {
  if (bot.status !== 'working') return null;
  const running = live?.parts.findLast((p) => p.type === 'tool' && p.state === 'running');
  return running?.type === 'tool' ? running : bot.activity;
}

/** Expression of a bot's character from its status and what it is doing right now. */
export function moodOf(bot: Pick<Bot, 'status' | 'activity'>, live?: Live): BotMood {
  switch (bot.status) {
    case 'working':
      return currentAction(bot, live) ? 'working' : 'thinking';
    case 'waiting_user':
    case 'waiting_bot':
      return 'waiting';
    case 'error':
      return 'error';
    case 'paused':
      return 'sleeping';
    default:
      return 'idle';
  }
}

/** Busy: the bot is on something (its words shimmer). */
export const isBusy = (bot: Pick<Bot, 'status'>) =>
  bot.status === 'working' || bot.status === 'waiting_bot' || bot.status === 'waiting_user';

/**
 * What the bot is doing, in the app's language: its current action ("Lance npm", "Écrit à
 * Sacha · …"), "réfléchit…" between two, "attend Nova"…
 */
export function statusLabel(
  bot: Pick<Bot, 'status' | 'statusDetail' | 'activity'>,
  live?: Live,
): string {
  const { t } = i18n;
  switch (bot.status) {
    case 'working': {
      const action = currentAction(bot, live);
      return action ? actionTitle(action) : t('mood.thinking');
    }
    // statusDetail is the name of the bot whose answer it waits for.
    case 'waiting_bot':
      return bot.statusDetail
        ? t('mood.waitingFor', { name: bot.statusDetail })
        : t('mood.waitingForBot');
    case 'waiting_user':
      return t('mood.waitingUser');
    case 'error':
      return t('mood.error');
    case 'paused':
      return t('mood.paused');
    default:
      return t('mood.idle');
  }
}

/** A bot's line in a list: what it is doing, or its role while it rests. */
export function botLine(
  bot: Pick<Bot, 'status' | 'statusDetail' | 'activity' | 'role'>,
  live?: Live,
): string {
  return bot.status === 'idle' ? bot.role : statusLabel(bot, live);
}
