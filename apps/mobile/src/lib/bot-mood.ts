import type { Bot, Message } from '@mowbot/contract';
import type { CharacterMood } from '@mowbot/design';
import type { TFunction } from 'i18next';
import { actionTitle } from './activity';

export type BotMood = CharacterMood;

/** The answer the bot is writing, when its conversation is known: it says first what runs. */
type Live = Pick<Message, 'parts'> | null | undefined;

/** The tool call the bot is running now (from its answer under way, else from the hub), if any. */
export function currentAction(
  bot: Pick<Bot, 'status' | 'activity'>,
  live?: Live,
): { toolName: string; input: unknown } | null {
  if (bot.status !== 'working') return null;
  const running = live?.parts.findLast((p) => p.type === 'tool' && p.state === 'running');
  return running?.type === 'tool' ? running : (bot.activity ?? null);
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

/** While a bot waits for another one's answer, the hub gives that bot's name (older hubs wrote "Attend Nova"). */
const WAITING_FOR = /^attend\s+(.+)$/i;

/**
 * What the bot is doing: its current action ("Lance npm", "Écrit à Sacha · …"), "réfléchit…"
 * between two, "attend Nova"…
 */
export function statusLabel(
  bot: Pick<Bot, 'status' | 'statusDetail' | 'activity'>,
  mood: BotMood,
  t: TFunction,
  live?: Live,
): string {
  if (bot.status === 'waiting_bot') {
    const name = bot.statusDetail?.match(WAITING_FOR)?.[1] ?? bot.statusDetail;
    return name ? t('status.waitingFor', { name }) : t('status.waitingBot');
  }
  if (mood === 'working') {
    const action = currentAction(bot, live);
    return action ? actionTitle(action, t) : t('status.working');
  }
  if (mood === 'thinking') return t('status.thinking');
  if (bot.status === 'waiting_user') return t('status.waitingUser');
  if (bot.status === 'error') return t('status.error');
  if (bot.status === 'paused') return t('status.paused');
  return t('status.idle');
}

/**
 * A bot's line in a list: what it works on and, while at it, what it does right now
 * ("Je développe la page d'accueil · Lance npm"); its role when it has nothing to say.
 */
export function botLine(
  bot: Pick<Bot, 'status' | 'statusDetail' | 'activity' | 'focus' | 'role'>,
  mood: BotMood,
  t: TFunction,
  live?: Live,
): string {
  const status = bot.status === 'idle' ? null : statusLabel(bot, mood, t, live);
  return [bot.focus, status].filter(Boolean).join(' · ') || bot.role;
}
