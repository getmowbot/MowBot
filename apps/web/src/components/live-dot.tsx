import { cn } from '../lib/utils';

/** A small pulsing dot: something on screen is kept up to date by a running automation. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-1.5 shrink-0', className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
    </span>
  );
}
