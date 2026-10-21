import type { Bot, Question } from '@mowbot/contract';
import { ArrowUp, PenLine } from 'lucide-react';
import { motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { useAnswerQuestion } from '../lib/proactivity';
import { cn, timeAgo } from '../lib/utils';
import { BotAvatar } from './bot-avatar';
import { Button } from './ui/button';
import { Input } from './ui/form';

/**
 * A question a bot asked: one click on a suggested answer, or the user's own words. The answer
 * reaches the bot as a message from the user. `bot` shows who asks (on the home page).
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
  const [writing, setWriting] = useState(question.options.length === 0);
  const [text, setText] = useState('');

  const send = (value: string) => answer.mutate({ id: question.id, answer: value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) send(text.trim());
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
      className={cn(
        'space-y-3 rounded-2xl border border-border-strong bg-white/[0.03] p-3.5',
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        {bot && <BotAvatar seed={bot.avatarSeed} size={28} mood="waiting" />}
        <div className="min-w-0 flex-1">
          {bot && (
            <p className="text-xs text-muted-foreground">
              {t('questions.from', { name: bot.name })} · {timeAgo(question.createdAt)}
            </p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm font-medium">{question.question}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {question.options.map((option) => (
          <Button
            key={option}
            size="sm"
            variant="outline"
            disabled={answer.isPending}
            onClick={() => send(option)}
          >
            {option}
          </Button>
        ))}
        {!writing && (
          <Button size="sm" variant="ghost" onClick={() => setWriting(true)}>
            <PenLine className="size-3.5" /> {t('questions.other')}
          </Button>
        )}
      </div>
      {writing && (
        <form onSubmit={submit} className="flex gap-2">
          <Input
            autoFocus={question.options.length > 0}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t('questions.placeholder')}
            maxLength={2000}
            className="h-9"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!text.trim() || answer.isPending}
            aria-label={t('questions.send')}
          >
            <ArrowUp className="size-4" />
          </Button>
        </form>
      )}
      {answer.isError && (
        <p role="alert" className="text-xs text-destructive">
          {problemMessage(answer.error, t('common.actionFailed'))}
        </p>
      )}
    </motion.div>
  );
}
