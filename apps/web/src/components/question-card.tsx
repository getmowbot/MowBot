import type { Bot, Question } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { ArrowUp, ExternalLink, MessageCircleQuestion, PenLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { useAnswerQuestion, useDismissQuestion } from '../lib/proactivity';
import { useBots } from '../lib/queries';
import { cn, timeAgo } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { CanvasImage } from './canvas-body';
import { Markdown } from './markdown';
import { Button } from './ui/button';

/** A suggested answer: a pill, one click away. */
const CHIP =
  'inline-flex h-9 items-center gap-1.5 rounded-full border border-border-strong bg-ink/[0.03] px-4 text-sm font-medium text-foreground/90 transition-[background-color,border-color,color] duration-200 hover:border-ink/25 hover:bg-ink/[0.08] hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

/**
 * A question a bot asked: one click on a suggested answer, the user's own words, or set aside
 * without answering (the bot is not told). The answer reaches the bot as a message from the
 * user. `bot` shows who asks (on the home page).
 */
export function QuestionCard({
  question,
  bot,
  className,
}: {
  question: Question;
  bot?: Bot;
  className?: string;
}) {
  const { t } = useTranslation();
  const answer = useAnswerQuestion();
  const dismiss = useDismissQuestion();
  // Its picture may be a file of the asking bot's workspace.
  const bots = useBots();
  const asker = bot ?? bots.data?.find((b) => b.id === question.botId);
  const [writing, setWriting] = useState(question.options.length === 0);
  const [text, setText] = useState('');
  const busy = answer.isPending || dismiss.isPending;

  const send = (value: string) => answer.mutate({ id: question.id, answer: value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) send(text.trim());
  };
  const failed = answer.error ?? dismiss.error;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -6, scale: 0.98, filter: 'blur(6px)' }}
      transition={springs.soft}
      className={cn('glass relative overflow-hidden rounded-[22px] p-4', className)}
    >
      {/* A soft light from the top left: something waits for the user. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-10 -top-16 size-40 rounded-full bg-info/[0.12] blur-3xl"
      />
      <button
        type="button"
        onClick={() => dismiss.mutate(question.id)}
        disabled={busy}
        aria-label={t('questions.dismiss')}
        title={t('questions.dismissHint')}
        className="absolute right-2.5 top-2.5 z-10 grid size-8 place-items-center rounded-full text-faint transition-colors duration-200 hover:bg-ink/[0.07] hover:text-foreground disabled:opacity-40"
      >
        <X className="size-4" />
      </button>
      <div className="relative space-y-3">
        <div className="flex items-center gap-2.5 pr-8">
          {bot ? (
            <BotAvatar seed={bot.avatarSeed} size={26} mood="waiting" />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-info/15 text-info">
              <MessageCircleQuestion className="size-3.5" />
            </span>
          )}
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {bot ? t('questions.from', { name: bot.name }) : t('questions.label')}
            <span className="text-faint"> · {timeAgo(question.createdAt)}</span>
          </p>
        </div>
        <p className="whitespace-pre-wrap break-words text-[15px] font-medium leading-snug">
          {question.question}
        </p>
        {question.image && (
          <CanvasImage
            src={question.image}
            alt={question.question}
            workspaceId={asker?.workspaceId ?? null}
            version={question.id}
            className="max-h-64 w-full rounded-xl object-cover"
            placeholderClassName="h-40 w-full rounded-xl"
          />
        )}
        {question.details && (
          <Markdown text={question.details} className="text-sm text-muted-foreground" />
        )}
        {question.link && (
          <a
            href={question.link.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground/90 underline-offset-2 hover:underline"
          >
            <ExternalLink className="size-3.5" /> {question.link.label}
          </a>
        )}
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <motion.button
              key={option}
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={springs.snappy}
              disabled={busy}
              onClick={() => send(option)}
              className={cn(CHIP, answer.variables?.answer === option && 'border-ink/30')}
            >
              {option}
            </motion.button>
          ))}
          {!writing && (
            <button
              type="button"
              onClick={() => setWriting(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground transition-colors duration-200 hover:bg-ink/[0.06] hover:text-foreground"
            >
              <PenLine className="size-3.5" /> {t('questions.other')}
            </button>
          )}
        </div>
        {writing && (
          <form
            onSubmit={submit}
            className="flex items-center gap-1.5 rounded-full border border-border-strong bg-ink/[0.03] p-1 pl-4 transition-colors duration-200 focus-within:border-ink/25"
          >
            <input
              // biome-ignore lint/a11y/noAutofocus: the user just asked to write
              autoFocus={question.options.length > 0}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('questions.placeholder')}
              aria-label={t('questions.placeholder')}
              maxLength={2000}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <Button
              type="submit"
              size="icon"
              className="size-8 rounded-full"
              disabled={!text.trim() || busy}
              aria-label={t('questions.send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          </form>
        )}
        {failed && (
          <p role="alert" className="text-xs text-destructive">
            {problemMessage(failed, t('common.actionFailed'))}
          </p>
        )}
      </div>
    </motion.div>
  );
}
