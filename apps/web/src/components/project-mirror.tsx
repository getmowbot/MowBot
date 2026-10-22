import type { Project, ProjectMirror } from '@mowbot/contract';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CircleAlert, Clock, FileWarning, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { mirrorTone, useDismissConflicts } from '../lib/projects';
import { cn, timeAgo } from '../lib/utils';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';

/** Where a mirror stands, in a few words: "In sync", "3 changes waiting for the computer"… */
export function useMirrorText() {
  const { t } = useTranslation();
  return (mirror: ProjectMirror, online: boolean): string => {
    switch (mirror.status) {
      case 'syncing':
        return t('projects.mirror.syncing');
      case 'waiting':
        return t('projects.mirror.waiting');
      case 'pending':
        return t('projects.mirror.pending', { count: mirror.pending });
      case 'too_big':
        return t('projects.mirror.tooBig');
      case 'error':
        return t('projects.mirror.error');
      default:
        return online ? t('projects.mirror.synced') : t('projects.mirror.syncedOffline');
    }
  };
}

const TONES = {
  ok: 'text-emerald-400',
  busy: 'text-sky-300',
  waiting: 'text-faint',
  warn: 'text-amber-300',
  error: 'text-destructive',
} as const;

/** On the project chip: nothing while in sync, else an icon and a count. */
export function MirrorBadge({ mirror, online }: { mirror: ProjectMirror; online: boolean }) {
  const { t } = useTranslation();
  const text = useMirrorText();
  const tone = mirrorTone(mirror);
  if (tone === 'ok') return null;
  const label = [
    text(mirror, online),
    mirror.conflicts.length
      ? t('projects.mirror.conflicts', { count: mirror.conflicts.length })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const Icon =
    tone === 'warn'
      ? AlertTriangle
      : tone === 'error'
        ? CircleAlert
        : tone === 'busy'
          ? RefreshCw
          : Clock;
  const count =
    tone === 'warn' ? mirror.conflicts.length : mirror.status === 'pending' ? mirror.pending : null;
  return (
    <span
      title={label}
      role="img"
      aria-label={label}
      className={cn('flex shrink-0 items-center gap-0.5 tabular-nums', TONES[tone])}
    >
      <Icon className={cn('size-3', tone === 'busy' && 'animate-spin')} />
      {count !== null && count > 0 && <span>{count}</span>}
    </span>
  );
}

/** A mirror's state on one line, with its conflicts to see. */
export function MirrorState({
  mirror,
  online,
  onConflicts,
  className,
}: {
  mirror: ProjectMirror;
  online: boolean;
  onConflicts(): void;
  className?: string;
}) {
  const { t } = useTranslation();
  const text = useMirrorText();
  // The state's own color; the conflicts have theirs next to it.
  const tone = mirrorTone({ ...mirror, conflicts: [] });
  return (
    <span className={cn('flex flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <span className={cn(tone === 'ok' ? 'text-muted-foreground' : TONES[tone])}>
        {text(mirror, online)}
      </span>
      {mirror.conflicts.length > 0 && (
        <button
          type="button"
          onClick={onConflicts}
          className="inline-flex items-center gap-1 rounded-md text-amber-300 underline-offset-2 hover:underline"
        >
          <AlertTriangle className="size-3" />
          {t('projects.mirror.conflicts', { count: mirror.conflicts.length })} ·{' '}
          {t('projects.mirror.see')}
        </button>
      )}
    </span>
  );
}

/** The files both the user and the bots changed: both versions to open, and to dismiss. */
export function ConflictsDialog({
  project,
  mirror,
  open,
  onClose,
}: {
  project: Project;
  mirror: ProjectMirror | null;
  open: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const dismiss = useDismissConflicts(project);
  const conflicts = mirror?.conflicts ?? [];
  const fileLink = (path: string) => ({
    to: '/workspaces/$workspaceId/files' as const,
    params: { workspaceId: mirror?.workspaceId ?? '' },
    search: { open: path },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-xl"
      title={t('projects.conflicts.title', { name: project.name })}
      description={t('projects.conflicts.intro')}
    >
      {conflicts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('projects.conflicts.none')}</p>
      ) : (
        <div className="space-y-3">
          <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {conflicts.map((conflict) => (
              <li key={`${conflict.path}-${conflict.at}`} className="flex items-center gap-3 p-3">
                <FileWarning className="size-4 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{conflict.path}</p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-faint">
                    <span>{timeAgo(conflict.at)}</span>
                    <Link
                      {...fileLink(`${mirror?.folder}/${conflict.path}`)}
                      onClick={onClose}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {t('projects.conflicts.yours')}
                    </Link>
                    <Link
                      {...fileLink(conflict.copy)}
                      onClick={onClose}
                      className="text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {t('projects.conflicts.theirs')}
                    </Link>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={dismiss.isPending || !mirror}
                  onClick={() =>
                    mirror &&
                    dismiss.mutate({ workspaceId: mirror.workspaceId, path: conflict.path })
                  }
                >
                  {t('projects.conflicts.dismiss')}
                </Button>
              </li>
            ))}
          </ul>
          {dismiss.isError && (
            <p className="text-xs text-destructive">
              {problemMessage(dismiss.error, t('projects.saveFailed'))}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-faint">{t('projects.conflicts.dismissHint')}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={dismiss.isPending || !mirror}
              onClick={() => mirror && dismiss.mutate({ workspaceId: mirror.workspaceId })}
            >
              {t('projects.conflicts.dismissAll')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
