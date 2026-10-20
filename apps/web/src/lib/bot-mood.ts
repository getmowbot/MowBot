import type { Bot, Message } from '@mowbot/contract';
import type { BotMood } from '../components/bot-avatar';
import { i18n } from '../i18n';

/** Expression of a bot's character from its status and what it is doing right now. */
export function moodOf(bot: Pick<Bot, 'status'>, live?: Message): BotMood {
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

/** What the bot is doing, in the app's language: "réfléchit…", "waiting for Nova". */
export function statusLabel(bot: Pick<Bot, 'status' | 'statusDetail'>, mood: BotMood): string {
  const { t } = i18n;
  // waiting_bot: statusDetail is the name of the bot whose answer it waits for.
  if (bot.status === 'waiting_bot') {
    return bot.statusDetail
      ? t('mood.waitingFor', { name: bot.statusDetail })
      : t('mood.waitingForBot');
  }
  if (mood === 'working') return t('mood.working');
  if (mood === 'thinking') return t('mood.thinking');
  if (bot.status === 'waiting_user') return t('mood.waitingUser');
  if (bot.status === 'error') return t('mood.error');
  if (bot.status === 'paused') return t('mood.paused');
  return t('mood.idle');
}
