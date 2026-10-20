import type { ComputerStatus } from '@mowbot/contract';
import { cn } from '../lib/utils';

const LABELS: Record<ComputerStatus, string> = {
  stopped: 'Éteint',
  starting: 'Démarrage…',
  running: 'Allumé',
  stopping: 'Arrêt…',
  error: 'Erreur',
};

const DOT: Record<ComputerStatus, string> = {
  stopped: 'bg-muted-foreground/40',
  starting: 'bg-amber-500 animate-pulse',
  running: 'bg-primary',
  stopping: 'bg-amber-500 animate-pulse',
  error: 'bg-destructive',
};

export function StatusDot({ status, className }: { status: ComputerStatus; className?: string }) {
  return (
    <span
      role="img"
      aria-label={LABELS[status]}
      className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)}
    />
  );
}

export function StatusBadge({ status }: { status: ComputerStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <StatusDot status={status} />
      {LABELS[status]}
    </span>
  );
}
