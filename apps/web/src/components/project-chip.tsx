import type { Bot, Project } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { Link } from '@tanstack/react-router';
import { Check, ChevronDown, FolderGit2, FolderX, Settings2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import {
  activeProject,
  projectsFor,
  useConnectors,
  useProjects,
  useSetBotProject,
} from '../lib/projects';
import { cn } from '../lib/utils';

const Dot = ({ on }: { on: boolean }) => (
  <span
    aria-hidden
    className={cn(
      'inline-block size-1.5 shrink-0 rounded-full',
      on ? 'bg-emerald-400' : 'bg-white/25',
    )}
  />
);

function Choice({
  checked,
  onPick,
  icon,
  title,
  hint,
}: {
  checked: boolean;
  onPick(): void;
  icon: ReactNode;
  title: string;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-checked={checked || undefined}
      onClick={onPick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none"
    >
      <span className="grid size-[22px] shrink-0 place-items-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {hint && (
          <span className="flex items-center gap-1.5 truncate text-xs text-faint">{hint}</span>
        )}
      </span>
      {checked && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

/**
 * Over the message field: the project the bot works in (a folder shared from the user's computer),
 * and a menu to pick another or none. Hidden while the bot may use no project.
 */
export function ProjectChip({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const projects = useProjects();
  const computers = useConnectors();
  const set = useSetBotProject(bot);
  const root = useRef<HTMLDivElement>(null);
  const usable = projectsFor(bot, projects.data);
  const current = activeProject(bot, projects.data);

  useEffect(() => {
    if (!open) return;
    // Opened from the keyboard (`/project`): the current choice takes the focus.
    requestAnimationFrame(() =>
      (
        root.current?.querySelector<HTMLElement>('[data-checked]') ??
        root.current?.querySelector<HTMLElement>('[role="menuitemradio"]')
      )?.focus(),
    );
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      // Up and down move between the choices.
      const items = [
        ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
      ];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at === -1) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  if (usable.length === 0 && !current) return null;

  const where = (project: Project) => {
    const computer = computers.data?.find((c) => c.id === project.connectorId);
    return computer?.hostname ?? computer?.name ?? '…';
  };
  const pick = (projectId: string | null) => {
    onOpenChange(false);
    if (projectId !== (current?.id ?? null)) set.mutate(projectId);
  };
  const offline = current && !current.online;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={offline ? t('chat.project.offlineHint', { computer: where(current) }) : undefined}
        className={cn(
          'flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-white/[0.02] px-2.5 py-1 text-xs transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06]',
          current ? 'text-foreground/90' : 'text-muted-foreground',
        )}
      >
        <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{current ? current.name : t('chat.project.none')}</span>
        {current && <Dot on={current.online} />}
        {offline && <span className="shrink-0 text-faint">{t('projects.offline')}</span>}
        <ChevronDown
          className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={t('chat.project.title')}
            initial={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            transition={springs.snappy}
            style={{ background: 'var(--card)' }}
            className="glass absolute bottom-full left-0 z-40 mb-2 w-72 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl p-1"
          >
            <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
              {t('chat.project.title')}
            </p>
            {usable.map((project) => (
              <Choice
                key={project.id}
                checked={project.id === current?.id}
                onPick={() => pick(project.id)}
                icon={<FolderGit2 className="size-4" />}
                title={project.name}
                hint={
                  <>
                    <Dot on={project.online} />
                    {t(project.online ? 'projects.onlineOn' : 'projects.offlineOn', {
                      computer: where(project),
                    })}
                  </>
                }
              />
            ))}
            <Choice
              checked={!current}
              onPick={() => pick(null)}
              icon={<FolderX className="size-4" />}
              title={t('chat.project.none')}
            />
            {usable.some((p) => !p.online) && (
              <p className="px-2.5 pt-1 pb-1.5 text-xs text-faint">{t('chat.project.offline')}</p>
            )}
            <div className="mt-1 border-t border-border pt-1">
              <Link
                to="/settings/projects"
                onClick={() => onOpenChange(false)}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <Settings2 className="size-4" /> {t('chat.project.manage')}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {set.isError && (
        <p className="mt-1 text-xs text-destructive">
          {problemMessage(set.error, t('chat.project.failed'))}
        </p>
      )}
    </div>
  );
}
