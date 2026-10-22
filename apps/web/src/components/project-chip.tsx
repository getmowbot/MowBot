import type { Bot, Connector, Project } from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { Link } from '@tanstack/react-router';
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderPlus,
  FolderSync,
  FolderX,
  Laptop,
  Loader2,
  Settings2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import {
  activeProject,
  inDesktopApp,
  mirrorFor,
  PICK_FROM,
  projectsFor,
  useAddFolderHere,
  useConnectors,
  usePickOnComputer,
  useProjects,
  useSetBotProject,
  versionAtLeast,
} from '../lib/projects';
import { cn } from '../lib/utils';
import { ConflictsDialog, MirrorBadge, MirrorState } from './project-mirror';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

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

const itemClass =
  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:bg-white/[0.06] focus-visible:outline-none';

/**
 * Away from the computer (browser, another device): a folder is added from its desktop app, which
 * the hub can ask to open its folder picker.
 */
function AddFolderDialog({
  bot,
  computers,
  open,
  onClose,
}: {
  bot: Bot;
  computers: Connector[];
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const pick = usePickOnComputer(bot);
  const [asked, setAsked] = useState<Connector | null>(null);
  const online = computers.filter((computer) => computer.online);
  const close = () => {
    pick.reset();
    setAsked(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      className="max-w-md"
      title={t('chat.project.addTitle')}
      description={t('chat.project.addFromDesktop', { name: bot.name })}
    >
      <div className="space-y-2">
        {online.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('chat.project.noComputer')}</p>
        )}
        {online.map((computer) => {
          const name = computer.hostname ?? computer.name;
          const able = versionAtLeast(computer.version, PICK_FROM);
          const waiting = pick.isPending && asked?.id === computer.id;
          return able ? (
            <Button
              key={computer.id}
              variant="outline"
              className="w-full justify-start"
              disabled={pick.isPending}
              onClick={() => {
                setAsked(computer);
                pick.mutate(computer.id, {
                  onSuccess: (project) => {
                    if (project) close();
                  },
                });
              }}
            >
              {waiting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Laptop className="size-4" />
              )}
              {t('chat.project.pickOn', { computer: name })}
            </Button>
          ) : (
            <p key={computer.id} className="text-xs text-faint">
              {t('chat.project.updateApp', { computer: name })}
            </p>
          );
        })}
        {pick.isPending && asked && (
          <p className="text-xs text-muted-foreground">
            {t('chat.project.picking', { computer: asked.hostname ?? asked.name })}
          </p>
        )}
        {pick.isSuccess && pick.data === null && (
          <p className="text-xs text-faint">{t('chat.project.pickCancelled')}</p>
        )}
        {pick.isError && (
          <p className="text-xs text-destructive">
            {problemMessage(pick.error, t('chat.project.addFailed'))}
          </p>
        )}
        <div className="flex justify-between gap-2 pt-2">
          <Link
            to="/settings/projects"
            onClick={close}
            className="self-center text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('chat.project.manage')}
          </Link>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Over the message field: the project the bot works in (a folder shared from the user's computer,
 * mirrored in the bot's workspace), how its mirror stands, and a menu to pick another, none, or
 * add a folder. Hidden while there is nothing to pick nor any way to add one.
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
  const desktopApp = inDesktopApp();
  const addHere = useAddFolderHere(bot, t('projects.thisPc'));
  const [adding, setAdding] = useState(false);
  const [conflictsOf, setConflictsOf] = useState<Project | null>(null);

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

  // A folder can be added here (desktop app), or picked on a linked computer.
  const canAdd = desktopApp || (computers.data?.length ?? 0) > 0;
  if (usable.length === 0 && !current && !canAdd) return null;

  const where = (project: Project) => {
    const computer = computers.data?.find((c) => c.id === project.connectorId);
    return computer?.hostname ?? computer?.name ?? '…';
  };
  const pick = (projectId: string | null) => {
    onOpenChange(false);
    if (projectId !== (current?.id ?? null)) set.mutate(projectId);
  };
  const add = () => {
    onOpenChange(false);
    if (desktopApp) addHere.mutate();
    else setAdding(true);
  };
  const mirror = current ? mirrorFor(current, bot) : null;
  const offline = current && !current.online;
  const error = set.isError
    ? problemMessage(set.error, t('chat.project.failed'))
    : addHere.isError
      ? problemMessage(addHere.error, t('chat.project.addFailed'))
      : null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          offline && !mirror
            ? t('chat.project.offlineHint', { computer: where(current) })
            : undefined
        }
        className={cn(
          'flex max-w-full items-center gap-1.5 rounded-full border border-border-strong bg-white/[0.02] px-2.5 py-1 text-xs transition-colors duration-200 hover:border-primary/40 hover:bg-primary/[0.06]',
          current ? 'text-foreground/90' : 'text-muted-foreground',
        )}
      >
        {addHere.isPending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{current ? current.name : t('chat.project.none')}</span>
        {current && <Dot on={current.online} />}
        {offline && <span className="shrink-0 text-faint">{t('projects.offline')}</span>}
        {current && mirror && <MirrorBadge mirror={mirror} online={current.online} />}
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
            className="glass absolute bottom-full left-0 z-40 mb-2 w-80 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl p-1"
          >
            <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">
              {t('chat.project.title')}
            </p>
            {current && mirror && (
              <div className="mx-1 mb-1 flex items-start gap-2 rounded-lg bg-white/[0.03] px-2 py-1.5 text-xs">
                <FolderSync className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {t('chat.project.mirror', { folder: mirror.folder })}
                  </p>
                  <MirrorState
                    mirror={mirror}
                    online={current.online}
                    onConflicts={() => {
                      onOpenChange(false);
                      setConflictsOf(current);
                    }}
                  />
                </div>
              </div>
            )}
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
            {usable.some((p) => !p.online && !p.mirror) && (
              <p className="px-2.5 pt-1 pb-1.5 text-xs text-faint">{t('chat.project.offline')}</p>
            )}
            <div className="mt-1 border-t border-border pt-1">
              {canAdd && (
                <button type="button" role="menuitem" onClick={add} className={itemClass}>
                  <FolderPlus className="size-4" /> {t('chat.project.add')}
                </button>
              )}
              <Link
                to="/settings/projects"
                onClick={() => onOpenChange(false)}
                className={itemClass}
              >
                <Settings2 className="size-4" /> {t('chat.project.manage')}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      {!desktopApp && (
        <AddFolderDialog
          bot={bot}
          computers={computers.data ?? []}
          open={adding}
          onClose={() => setAdding(false)}
        />
      )}
      {conflictsOf && (
        <ConflictsDialog
          project={projects.data?.find((p) => p.id === conflictsOf.id) ?? conflictsOf}
          mirror={mirrorFor(
            projects.data?.find((p) => p.id === conflictsOf.id) ?? conflictsOf,
            bot,
          )}
          open
          onClose={() => setConflictsOf(null)}
        />
      )}
    </div>
  );
}
