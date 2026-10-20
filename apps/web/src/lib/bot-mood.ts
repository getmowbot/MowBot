import type { Bot, Message } from '@mowbot/contract';
import type { BotMood } from '../components/bot-avatar';

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

export function statusLabel(bot: Pick<Bot, 'status' | 'statusDetail'>, mood: BotMood): string {
  // "Attend Nova": waiting for another bot's answer.
  if (bot.status === 'waiting_bot') {
    const detail = bot.statusDetail ?? 'Attend un autre bot';
    return detail.charAt(0).toLowerCase() + detail.slice(1);
  }
  if (mood === 'working') return 'travaille sur son PC…';
  if (mood === 'thinking') return 'réfléchit…';
  if (bot.status === 'waiting_user') return 'attend ta réponse';
  if (bot.status === 'error') return 'a rencontré un problème';
  if (bot.status === 'paused') return 'en pause';
  return 'disponible';
}
