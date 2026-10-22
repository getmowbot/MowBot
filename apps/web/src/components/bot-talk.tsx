import type { Bot } from '@mowbot/contract';
import { Link } from '@tanstack/react-router';
import { MessageSquareText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChipBot } from '../lib/incoming';
import { cn, timeAgo } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Markdown } from './markdown';
import { Dialog } from './ui/dialog';

/** What bots said to each other, opened large. */
export interface Talk {
  /** "Message de Nova", "Question à Hans"… */
  title: string;
  /** The other bot: its conversation opens from the talk (a deleted bot has no id). */
  bot: ChipBot;
  text: string;
  /** A question's answer, once it came back. */
  answer?: { title: string; text: string };
  at?: string;
}

/** Every bot as a chip, for the names a talk's text holds. */
export const chipsOf = (bots: Bot[] | undefined): ChipBot[] =>
  (bots ?? []).map(({ id, name, avatarSeed, isChef }) => ({ id, name, avatarSeed, isChef }));

/** A message between bots on one line: who, then what in a few words. Opens it large. */
export function TalkLine({
  title,
  bot,
  summary,
  onOpen,
  className,
}: {
  title: string;
  bot: ChipBot;
  summary: string;
  onOpen(): void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex max-w-full items-center gap-2 rounded-full bg-ink/[0.04] py-1 pl-1.5 pr-3 text-left text-[13px] transition-colors duration-200 hover:bg-ink/[0.08]',
        className,
      )}
    >
      <BotAvatar seed={bot.avatarSeed} size={20} className="shrink-0" />
      <span className="shrink-0 font-medium text-muted-foreground">{title}</span>
      {summary && (
        <>
          <span className="shrink-0 text-faint">·</span>
          <span className="min-w-0 truncate text-foreground/75 transition-colors duration-200 group-hover:text-foreground">
            {summary}
          </span>
        </>
      )}
    </button>
  );
}

/** A talk opened large: the whole text, the answer under it, and a way to the other bot. */
export function TalkDialog({
  talk,
  chips,
  open,
  onClose,
}: {
  talk: Talk;
  chips: ChipBot[];
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { bot } = talk;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-2xl"
      title={
        <span className="flex items-center gap-2.5">
          <BotAvatar seed={bot.avatarSeed} size={28} />
          {talk.title}
        </span>
      }
      description={talk.at ? timeAgo(talk.at) : undefined}
    >
      <div className="space-y-5">
        <Markdown text={talk.text} bots={chips} className="text-[15px] leading-relaxed" />
        {talk.answer && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="flex items-center gap-1.5 text-xs font-medium text-faint">
              <MessageSquareText className="size-3.5" />
              {talk.answer.title}
            </p>
            <Markdown
              text={talk.answer.text}
              bots={chips}
              className="text-[15px] leading-relaxed"
            />
          </div>
        )}
        {bot.id && (
          <div className="flex justify-end">
            <Link
              to={bot.isChef ? '/chef' : '/bots/$botId'}
              params={{ botId: bot.id }}
              onClick={onClose}
              className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
            >
              {t('chat.talk.openChat', { name: bot.name })} →
            </Link>
          </div>
        )}
      </div>
    </Dialog>
  );
}
