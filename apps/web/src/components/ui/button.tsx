import { springs } from '@mowbot/design';
import { cva, type VariantProps } from 'class-variance-authority';
import { type HTMLMotionProps, motion } from 'motion/react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        default:
          'border-beam bg-white/[0.03] text-foreground hover:bg-primary hover:text-primary-foreground',
        outline:
          'border border-border-strong bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.06]',
        ghost: 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
        destructive:
          'bg-destructive/15 text-destructive ring-1 ring-destructive/30 hover:bg-destructive/25',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 px-5 text-[15px]',
        icon: 'size-9',
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
