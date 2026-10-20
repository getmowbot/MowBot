import { type BotGenome, botGenome, springs } from '@mowbot/design';
import {
  animate,
  type MotionValue,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/utils';

export type BotMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'sleeping' | 'error';

interface Props {
  seed: string;
  size?: number;
  mood?: BotMood;
  /** Eyes follow the pointer while it moves, and wander on their own otherwise. */
  followPointer?: boolean;
  /** Small red dot (unread, needs attention). */
  badge?: boolean;
  className?: string;
  title?: string;
}

const BODY: Record<BotGenome['body'], string> = {
  circle: 'M50 2a48 48 0 1 0 0.001 0Z',
  squircle: 'M50 3C85 3 97 15 97 50S85 97 50 97 3 85 3 50 15 3 50 3Z',
  drop: 'M32 7C49 1 86 5 94 30C101 52 95 79 73 92C53 103 18 98 8 76C-1 55 9 15 32 7Z',
  pebble: 'M52 3C80 4 98 22 97 52C96 80 76 98 48 97C22 96 3 78 4 50C5 22 24 2 52 3Z',
};

/** How far the eye pair travels from the center, in body units. */
const TRAVEL = { x: 15, y: 11 };
const EYE_Y = 42;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Where the eyes look next (-1..1 on each axis) and when to move again, per mood. */
function nextGaze(mood: BotMood, curiosity: number): { x: number; y: number; delay: number } {
  switch (mood) {
    case 'thinking': {
      const side = Math.random() < 0.65 ? 1 : -1;
      return { x: side * rand(0.45, 0.9), y: rand(-0.95, -0.6), delay: rand(1200, 2600) };
    }
    case 'working':
      // Reading: quick saccades along a line, slightly down.
      return { x: rand(-0.85, 0.85), y: rand(0.3, 0.55), delay: rand(260, 700) };
    case 'waiting':
      return { x: rand(-0.08, 0.08), y: rand(-0.05, 0.08), delay: rand(1500, 2800) };
    case 'error':
      return { x: rand(-0.25, 0.25), y: rand(0.4, 0.7), delay: rand(1800, 3200) };
    case 'sleeping':
      return { x: 0, y: 0.25, delay: 4000 };
    default: {
      if (Math.random() < 0.3) return { x: 0, y: 0, delay: rand(900, 2600) / curiosity };
      const angle = Math.random() * Math.PI * 2;
      const reach = rand(0.35, 1) * curiosity;
      return {
        x: Math.cos(angle) * reach,
        y: Math.sin(angle) * reach * 0.8,
        delay: rand(700, 3000) / (0.6 + curiosity * 0.6),
      };
    }
  }
}

/** Eye height multiplier per mood (blinks multiply on top). */
const OPENNESS: Record<BotMood, number> = {
  idle: 1,
  thinking: 0.9,
  working: 0.62,
  waiting: 1.15,
  sleeping: 1,
  error: 0.7,
};

interface EyeProps {
  cx: number;
  genome: BotGenome;
  scaleY: MotionValue<number>;
  mood: BotMood;
  side: -1 | 1;
}

function Eye({ cx, genome, scaleY, mood, side }: EyeProps) {
  const { eyeWidth: w, eyeHeight: h } = genome;
  if (mood === 'sleeping') {
    // Closed: a soft downward arc.
    return (
      <path
        d={`M${cx - w * 0.85} ${EYE_Y} Q${cx} ${EYE_Y + w * 1.1} ${cx + w * 0.85} ${EYE_Y}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={3.4}
        strokeLinecap="round"
      />
    );
  }
  return (
    <motion.rect
      x={cx - w / 2}
      y={EYE_Y - h / 2}
      width={w}
      height={h}
      rx={w / 2}
      fill="#ffffff"
      style={{ scaleY, transformBox: 'fill-box', transformOrigin: 'center' }}
      // Worried brows when something went wrong.
      animate={{ rotate: mood === 'error' ? side * -16 : 0 }}
      transition={springs.soft}
    />
  );
}

/**
 * A bot as a little character: flat colored body, two white pill eyes that blink at the
 * bot's own rhythm and glance around (or follow the pointer), with an expression per mood.
 */
export function BotAvatar({
  seed,
  size = 40,
  mood = 'idle',
  followPointer = false,
  badge = false,
  className,
  title,
}: Props) {
  const genome = useMemo(() => botGenome(seed), [seed]);
  const reduced = useReducedMotion();
  const root = useRef<SVGSVGElement>(null);
  const moodRef = useRef(mood);
  const pointerAt = useRef(0);

  const gazeX = useMotionValue(0);
  const gazeY = useMotionValue(0);
  const eyesX = useTransform(gazeX, (v) => v * TRAVEL.x);
  const eyesY = useTransform(gazeY, (v) => v * TRAVEL.y);
  const blink = useMotionValue(1);
  const openness = useMotionValue(OPENNESS[mood]);
  const scaleY = useTransform([blink, openness], ([b, o]) => (b as number) * (o as number));

  useEffect(() => {
    moodRef.current = mood;
    animate(openness, OPENNESS[mood], springs.soft);
  }, [mood, openness]);

  // Gaze: wander, read, ponder… according to the mood. Reduced motion keeps the glances
  // (small, local movements) but makes them rarer and softer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const target = nextGaze(moodRef.current, genome.curiosity);
      if (Date.now() - pointerAt.current > 2500) {
        const spring = reduced || moodRef.current === 'thinking' ? springs.drift : springs.gaze;
        animate(gazeX, target.x, spring);
        animate(gazeY, target.y, spring);
      }
      timer = setTimeout(step, target.delay * (reduced ? 2 : 1));
    };
    timer = setTimeout(step, rand(200, 900));
    return () => clearTimeout(timer);
  }, [reduced, genome.curiosity, gazeX, gazeY]);

  // Blinks at the bot's own rhythm, sometimes twice in a row.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    // One keyframed animation: it can never be left half-closed.
    const close = () =>
      animate(blink, [1, 0.08, 1], { duration: 0.2, times: [0, 0.35, 1], ease: 'easeInOut' });
    const schedule = () => {
      timer = setTimeout(
        async () => {
          if (cancelled) return;
          if (moodRef.current !== 'sleeping') {
            await close();
            if (Math.random() < 0.16) await close();
          }
          schedule();
        },
        rand(0.45, 1.55) * genome.blinkEvery * 1000,
      );
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [blink, genome.blinkEvery]);

  // Follow the pointer, saturating a few hundred pixels away.
  useEffect(() => {
    if (!followPointer) return;
    const onMove = (event: PointerEvent) => {
      const box = root.current?.getBoundingClientRect();
      if (!box || moodRef.current === 'sleeping') return;
      pointerAt.current = Date.now();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const reach = 280;
      animate(gazeX, Math.max(-1, Math.min(1, dx / reach)), springs.gaze);
      animate(gazeY, Math.max(-1, Math.min(1, dy / reach)), springs.gaze);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [followPointer, gazeX, gazeY]);

  // State halos on larger avatars; still (not spinning) when motion is reduced.
  const halos = size >= 36;
  const pad = halos ? 14 : 2;
  const sleeping = mood === 'sleeping';
  const half = genome.eyeGap / 2;

  return (
    <svg
      ref={root}
      viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}
      width={size}
      height={size}
      role="img"
      aria-label={title}
      className={cn('shrink-0 overflow-visible', className)}
    >
      {halos && mood === 'working' && (
        <motion.circle
          cx={50}
          cy={50}
          r={58}
          fill="none"
          stroke={genome.color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="64 300"
          style={{ transformOrigin: '50px 50px' }}
          animate={reduced ? undefined : { rotate: 360 }}
          transition={{ duration: 1.25, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
        />
      )}
      {halos && mood === 'thinking' && (
        <motion.g
          style={{ transformOrigin: '50px 50px' }}
          animate={reduced ? undefined : { rotate: 360 }}
          transition={{ duration: 3.6, repeat: Number.POSITIVE_INFINITY, ease: 'linear' }}
        >
          {[0, 120, 240].map((angle, i) => (
            <circle
              key={angle}
              cx={50 + 58 * Math.cos((angle * Math.PI) / 180)}
              cy={50 + 58 * Math.sin((angle * Math.PI) / 180)}
              r={4 - i * 0.9}
              fill={genome.color}
              opacity={0.95 - i * 0.25}
            />
          ))}
        </motion.g>
      )}
      {halos && mood === 'waiting' && (
        <motion.circle
          cx={50}
          cy={50}
          r={57}
          fill="none"
          stroke={genome.color}
          strokeWidth={2.4}
          animate={reduced ? { opacity: 0.5 } : { opacity: [0.15, 0.7, 0.15] }}
          transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
        />
      )}

      <motion.g
        style={{
          transformOrigin: '50px 92px',
          filter: sleeping ? 'saturate(0.55) brightness(0.8)' : undefined,
        }}
        animate={reduced ? undefined : { scale: sleeping ? [1, 1.03, 1] : [1, 1.018, 1] }}
        transition={{
          duration: sleeping ? 5.5 : 4.2,
          repeat: Number.POSITIVE_INFINITY,
          ease: 'easeInOut',
        }}
      >
        <path d={BODY[genome.body]} fill={genome.color} />
        <motion.g style={{ x: eyesX, y: eyesY }}>
          <Eye cx={50 - half} genome={genome} scaleY={scaleY} mood={mood} side={-1} />
          <Eye cx={50 + half} genome={genome} scaleY={scaleY} mood={mood} side={1} />
        </motion.g>
      </motion.g>

      {(badge || mood === 'error') && (
        <circle cx={86} cy={12} r={12} fill="#ff3d5e" stroke="var(--background)" strokeWidth={5} />
      )}
    </svg>
  );
}

/** A team: up to three member characters huddled together. */
export function TeamAvatar({ seeds, size = 32 }: { seeds: string[]; size?: number }) {
  const members = seeds.slice(0, 3);
  if (members.length <= 1) {
    return (
      <span className="grid shrink-0 place-items-center" style={{ width: size, height: size }}>
        {members[0] ? (
          <BotAvatar seed={members[0]} size={size * 0.78} />
        ) : (
          // A team without bots yet: an empty seat.
          <span
            className="rounded-full border border-dashed border-border-strong"
            style={{ width: size * 0.7, height: size * 0.7 }}
          />
        )}
      </span>
    );
  }
  const small = size * 0.56;
  const spots =
    members.length === 2
      ? [
          { left: 0, top: size * 0.08 },
          { left: size - small, top: size - small - size * 0.08 },
        ]
      : [
          { left: (size - small) / 2, top: 0 },
          { left: 0, top: size - small },
          { left: size - small, top: size - small },
        ];
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }}>
      {members.map((seed, i) => (
        <span
          key={seed}
          className="absolute rounded-full ring-2 ring-background-raised"
          style={{ ...spots[i], width: small, height: small }}
        >
          <BotAvatar seed={seed} size={small} />
        </span>
      ))}
    </span>
  );
}
