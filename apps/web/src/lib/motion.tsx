import { springs } from '@mowbot/design';
import { type HTMLMotionProps, motion, type Variants } from 'motion/react';

/** Elements arrive by sharpening into place: fade, slight rise, blur → focus. No bounce. */
export const reveal: Variants = {
  hidden: { opacity: 0, y: 10, filter: 'blur(8px)' },
  shown: { opacity: 1, y: 0, filter: 'blur(0px)', transition: springs.soft },
};

export const stagger: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.045, delayChildren: 0.03 } },
};

export function Reveal({
  children,
  delay = 0,
  ...props
}: HTMLMotionProps<'div'> & { delay?: number }) {
  return (
    <motion.div
      initial="hidden"
      animate="shown"
      variants={reveal}
      transition={{ ...springs.soft, delay }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

export function Stagger({ children, ...props }: HTMLMotionProps<'div'>) {
  return (
    <motion.div initial="hidden" animate="shown" variants={stagger} {...props}>
      {children}
    </motion.div>
  );
}
