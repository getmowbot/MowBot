import { springs } from '@mowbot/design';
import { cva, type VariantProps } from 'class-variance-authority';
import { type HTMLMotionProps, motion } from 'motion/react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        // A white pebble (ink on the light look), a reflection sweeping by on hover.
        default: 'pebble',
        outline:
          'border border-border-strong bg-ink/[0.02] hover:border-ink/20 hover:bg-ink/[0.06]',
        ghost: 'text-muted-foreground hover:bg-ink/[0.06] hover:text-foreground',
        destructive:
          'bg-destructive/15 text-destructive ring-1 ring-destructive/30 hover:bg-destructive/25',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'size-9',
        /** Round, for the composer's send and record buttons. */
        round: 'size-10 rounded-full',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends Omit<HTMLMotionProps<'button'>, 'children'>,
    VariantProps<typeof buttonVariants> {
  children?: React.ReactNode;
}

/** Presses sink a touch on a stiff spring; no bounce back. */
export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <motion.button
      type={type}
      whileTap={{ scale: 0.965 }}
      transition={springs.snappy}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
