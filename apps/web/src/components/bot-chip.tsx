import { botGenome } from '@mowbot/design';
import { Link } from '@tanstack/react-router';
import type { ChipBot } from '../lib/incoming';
import { cn } from '../lib/utils';
import { BotAvatar } from './bot-avatar';

/**
 * A bot named in a line of text: its little character then its name, in its color (`plain`:
 * the line's own). Opens its chat; a deleted bot is only named.
 */
export function BotChip({ bot, plain = false }: { bot: ChipBot; plain?: boolean }) {
  const color = plain ? undefined : botGenome(bot.avatarSeed).color;
  const className = cn('whitespace-nowrap font-medium', plain && 'text-muted-foreground');
  const body = (
    <>
      <BotAvatar seed={bot.avatarSeed} size={14} className="mr-1 inline-block align-[-2px]" />
      {bot.name}
    </>
  );
  return bot.id ? (
    <Link
      to={bot.isChef ? '/chef' : '/bots/$botId'}
      params={{ botId: bot.id }}
      className={cn(className, 'hover:underline')}
      style={{ color }}
    >
      {body}
    </Link>
  ) : (
    <span className={className} style={{ color }}>
      {body}
    </span>
  );
}
