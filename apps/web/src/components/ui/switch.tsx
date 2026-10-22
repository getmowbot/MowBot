import { motion } from 'motion/react';
import { cn } from '../../lib/utils';

/** An on/off toggle; the knob glides to its side. */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-200',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-ink/[0.04]',
      )}
    >
      <motion.span
        layout
        className={cn(
          'absolute top-0.5 size-3.5 rounded-full',
          checked ? 'right-0.5 bg-primary-foreground' : 'left-0.5 bg-ink/50',
        )}
      />
    </button>
  );
}
