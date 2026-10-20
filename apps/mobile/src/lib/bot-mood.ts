import type { Bot, Message } from '@mowbot/contract';
import type { TFunction } from 'i18next';

export type BotMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'sleeping' | 'error';

/** Expression of a bot's character from its status and what it is doing right now. */
export function moodOf(bot: Pick<Bot, 'status'>, live?: Message | null): BotMood {
  switch (bot.status) {
    case 'working': {
      const runningTool = live?.parts.some((p) => p.type === 'tool' && p.state === 'running');
      return runningTool ? 'working' : 'thinking';
    }
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

/** The hub writes "Attend Nova" (French) while a bot waits for another one's answer. */
const WAITING_FOR = /^attend\s+(.+)$/i;

export function statusLabel(
  bot: Pick<Bot, 'status' | 'statusDetail'>,
  mood: BotMood,
  t: TFunction,
): string {
  if (bot.status === 'waiting_bot') {
    const name = bot.statusDetail?.match(WAITING_FOR)?.[1];
    return name ? t('status.waitingFor', { name }) : t('status.waitingBot');
  }
  if (mood === 'working') return t('status.working');
  if (mood === 'thinking') return t('status.thinking');
  if (bot.status === 'waiting_user') return t('status.waitingUser');
  if (bot.status === 'error') return t('status.error');
  if (bot.status === 'paused') return t('status.paused');
  return t('status.idle');
}
