import type { Bot, Message } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Ellipsis, Eraser, type LucideIcon, Pencil, Settings2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, problemMessage } from '../lib/auth';
import { cn } from '../lib/utils';
import { useOrgDialogs } from './org-dialogs';
import { Button } from './ui/button';

function MenuItem({
  icon: Icon,
  danger,
  onClick,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150',
        danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground/90 hover:bg-ink/[0.06]',
      )}
    >
      <Icon className="size-4 shrink-0" />
      {children}
    </button>
  );
}

/** "…" menu of a conversation: rename the bot, start the conversation over. */
/** Starts the conversation over, once the user confirms. */
export function useClearConversation(bot: Bot): () => void {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const clear = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/api/v1/bots/{id}/messages', {
        params: { path: { id: bot.id } },
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.setQueryData<Message[]>(['messages', bot.id], []),
    onError: (err) => alert(problemMessage(err, t('botMenu.clearFailed'))),
  });
  return () => {
    if (confirm(t('botMenu.clearConfirm', { name: bot.name }))) clear.mutate();
  };
}

export function BotMenu({ bot, onRename }: { bot: Bot; onRename(): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dialogs = useOrgDialogs();
  const clear = useClearConversation(bot);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('botMenu.options', { name: bot.name })}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Ellipsis className="size-4" />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, scale: 0.97, filter: 'blur(4px)' }}
            transition={springs.snappy}
            className="glass absolute right-0 top-full z-50 mt-2 w-60 origin-top-right rounded-xl p-1"
          >
            <MenuItem
              icon={Settings2}
              onClick={() => {
                setOpen(false);
                dialogs.botSettings(bot);
              }}
            >
              {t('botMenu.settings')}
            </MenuItem>
            <MenuItem
              icon={Pencil}
              onClick={() => {
                setOpen(false);
                onRename();
              }}
            >
              {t('botMenu.rename')}
            </MenuItem>
            {!bot.isChef && (
              <MenuItem
                icon={ArrowRightLeft}
                onClick={() => {
                  setOpen(false);
                  dialogs.moveBot(bot);
                }}
              >
                {t('botMenu.move')}
              </MenuItem>
            )}
            <MenuItem
              icon={Eraser}
              danger
              onClick={() => {
                setOpen(false);
                clear();
              }}
            >
              {t('botMenu.clear')}
            </MenuItem>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The bot's name, edited in place: Enter or leaving the field saves, Escape cancels. */
export function RenameField({ bot, onDone }: { bot: Bot; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await api.PATCH('/api/v1/bots/{id}', {
        params: { path: { id: bot.id } },
        body: { name },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<Bot[]>(['bots'], (list) =>
        list?.map((b) => (b.id === updated.id ? updated : b)),
      );
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('botMenu.nameRejected'))),
  });
  const submit = (value: string) => {
    const name = value.trim();
    if (!name || name === bot.name) onDone();
    else if (!rename.isPending) rename.mutate(name);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: opened on purpose from the menu
      autoFocus
      defaultValue={bot.name}
      maxLength={40}
      aria-label={t('botMenu.nameLabel')}
      aria-invalid={Boolean(error)}
      title={error ?? undefined}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') submit(event.currentTarget.value);
        if (event.key === 'Escape') onDone();
      }}
      onBlur={(event) => submit(event.currentTarget.value)}
      className={cn(
        '-mx-1.5 w-full max-w-64 rounded-md bg-ink/[0.06] px-1.5 font-semibold leading-tight outline-none ring-1',
        error ? 'ring-destructive/60' : 'ring-ink/30',
      )}
    />
  );
}
