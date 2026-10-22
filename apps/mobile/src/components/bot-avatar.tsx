import {
  type BodyShape,
  type BotGenome,
  botGenome,
  type Expression,
  FACES,
  HAPPY_MS,
  HEAD_FOLLOW,
} from '@mowbot/design';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type EntryExitAnimationFunction,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { bump, expressionAfter, glanceStretch, keyframes } from '../lib/bot-expression';
import type { BotMood } from '../lib/bot-mood';
import { colors, springs, themed } from '../theme';

/** Same silhouettes as the web character (100×100 body box). */
const BODY: Record<BodyShape, string> = {
  circle: 'M50 2a48 48 0 1 0 0.001 0Z',
  squircle: 'M50 3C85 3 97 15 97 50S85 97 50 97 3 85 3 50 15 3 50 3Z',
  drop: 'M32 7C49 1 86 5 94 30C101 52 95 79 73 92C53 103 18 98 8 76C-1 55 9 15 32 7Z',
  pebble: 'M52 3C80 4 98 22 97 52C96 80 76 98 48 97C22 96 3 78 4 50C5 22 24 2 52 3Z',
};

/** How far the eye pair travels from the center, in body units. */
const TRAVEL = { x: 15, y: 11 };
const EYE_Y = 42;
/** The head turns, leans and breathes around a point near the bottom of the body. */
const PIVOT = { x: 50, y: 92 };

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

/** Asleep: a soft downward arc. Happy: an upturned one, like a smile in the eyes. */
function arcPath(cx: number, w: number, shape: 'closed' | 'happy') {
  const bend = shape === 'closed' ? w * 1.1 : -w * 1.25;
  const y = shape === 'closed' ? EYE_Y : EYE_Y + w * 0.45;
  return `M${cx - w * 0.85} ${y} Q${cx} ${y + bend} ${cx + w * 0.85} ${y}`;
}

// One keyframed blink (or two in a row): it can never be left half-closed.
const shut = () => withTiming(0.08, { duration: 70, easing: Easing.inOut(Easing.quad) });
const reopen = () => withTiming(1, { duration: 130, easing: Easing.inOut(Easing.quad) });
const blinking = (twice: boolean) =>
  twice ? withSequence(shut(), reopen(), shut(), reopen()) : withSequence(shut(), reopen());

const SNAPPY = springs.snappy;

/** Arc eyes draw in from their middle. */
const drawIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scaleX: 0.3 }] },
    animations: {
      opacity: withSpring(1, SNAPPY),
      transform: [{ scaleX: withSpring(1, SNAPPY) }],
    },
  };
};

/** The thought bubble pops in and out from its tail. */
const popIn: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0 }] },
    animations: { opacity: withSpring(1, SNAPPY), transform: [{ scale: withSpring(1, SNAPPY) }] },
  };
};
const popOut: EntryExitAnimationFunction = () => {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: { opacity: withSpring(0, SNAPPY), transform: [{ scale: withSpring(0, SNAPPY) }] },
  };
};

/** The expression shown: the mood, or a beat of joy right after the bot is done working. */
function useExpression(mood: BotMood): Expression {
  const [shown, setShown] = useState(mood);
  const [happy, setHappy] = useState(false);
  if (shown !== mood) {
    setShown(mood);
    setHappy(expressionAfter(shown, mood) === 'happy');
  }
  useEffect(() => {
    if (!happy) return;
    const timer = setTimeout(() => setHappy(false), HAPPY_MS);
    return () => clearTimeout(timer);
  }, [happy]);
  return happy ? 'happy' : mood;
}

interface Props {
  seed: string;
  size?: number;
  mood?: BotMood;
  /** Small red dot (needs attention). */
  badge?: boolean;
  /** No blinking or glances (tiny avatars in dense lists). */
  still?: boolean;
}

/** Maps the web avatar's SVG coordinates (body box padded by `pad`) to points. */
function frame(size: number, pad: number) {
  const scale = size / (100 + pad * 2);
  return { scale, at: (v: number) => (v + pad) * scale };
}

interface EyeProps {
  cx: number;
  genome: BotGenome;
  at(v: number): number;
  scale: number;
  blink: SharedValue<number>;
  open: SharedValue<number>;
  tilt: SharedValue<number>;
  stretch: SharedValue<number>;
}

function Eye({ cx, genome, at, scale, blink, open, tilt, stretch }: EyeProps) {
  const style = useAnimatedStyle(() => ({
    transform: [
      // A quick glance stretches the eye sideways; it tilts and opens along its own axis.
      { scaleX: stretch.get() },
      { rotate: `${tilt.get()}deg` },
      { scaleY: blink.get() * open.get() },
    ],
  }));
  const width = genome.eyeWidth * scale;
  return (
    <Animated.View
      style={[
        styles.eye,
        {
          left: at(cx - genome.eyeWidth / 2),
          top: at(EYE_Y - genome.eyeHeight / 2),
          width,
          height: genome.eyeHeight * scale,
          borderRadius: width / 2,
        },
        style,
      ]}
    />
  );
}

interface ArcEyeProps {
  cx: number;
  width: number;
  shape: 'closed' | 'happy';
  at(v: number): number;
  scale: number;
}

function ArcEye({ cx, width, shape, at, scale }: ArcEyeProps) {
  const half = width + 2;
  const side = half * 2 * scale;
  return (
    <Animated.View
      entering={drawIn}
      style={[
        styles.abs,
        { left: at(cx - half), top: at(EYE_Y - half), width: side, height: side },
      ]}
    >
      <Svg
        width={side}
        height={side}
        viewBox={`${cx - half} ${EYE_Y - half} ${half * 2} ${half * 2}`}
      >
        <Path
          d={arcPath(cx, width, shape)}
          fill="none"
          stroke="#ffffff"
          strokeWidth={3.6}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

/** A continuous turn (working arc); still when motion is reduced. */
function useSpin(period: number, reduced: boolean) {
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    turn.set(withRepeat(withTiming(360, { duration: period, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(turn);
  }, [period, reduced, turn]);
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
}

/** A cycle from 0 to 1, repeated forever after `delay` ms; 0 when `still`. */
function useCycle(period: number, delay: number, still: boolean) {
  const progress = useSharedValue(0);
  useEffect(() => {
    if (still) return;
    progress.set(
      withDelay(
        delay,
        withRepeat(withTiming(1, { duration: period, easing: Easing.linear }), -1, false),
      ),
    );
    return () => cancelAnimation(progress);
  }, [period, delay, still, progress]);
  return progress;
}

interface HaloProps {
  size: number;
  pad: number;
  color: string;
  reduced: boolean;
}

function WorkingArc({ size, pad, color, reduced }: HaloProps) {
  const spin = useSpin(1250, reduced);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, spin]} pointerEvents="none">
      <Svg width={size} height={size} viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}>
        <Circle
          cx={50}
          cy={50}
          r={58}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="64 300"
        />
      </Svg>
    </Animated.View>
  );
}

function WaitingRing({ size, pad, color, reduced }: HaloProps) {
  const pulse = useSharedValue(0.5);
  useEffect(() => {
    if (reduced) return;
    pulse.set(0.15);
    pulse.set(
      withRepeat(withTiming(0.7, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true),
    );
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.get() }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <Svg width={size} height={size} viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}>
        <Circle cx={50} cy={50} r={57} fill="none" stroke={color} strokeWidth={2.4} />
      </Svg>
    </Animated.View>
  );
}

/** The thought bubble's box, in body units: it reaches past the top right of the avatar. */
const BUBBLE = { x: 72, y: -22, width: 60, height: 52, tail: { x: 76, y: 26 } };
const THOUGHT_DOT = 2.6;

interface BubbleProps {
  color: string;
  at(v: number): number;
  scale: number;
  still: boolean;
}

function ThoughtDot({ index, color, scale, still }: Omit<BubbleProps, 'at'> & { index: number }) {
  const progress = useCycle(1100, index * 180, still);
  const style = useAnimatedStyle(() => {
    const lift = still ? 0 : bump(progress.get());
    return {
      opacity: still ? 0.8 : 0.35 + 0.65 * lift,
      transform: [{ translateY: -2.5 * lift * scale }],
    };
  });
  const side = THOUGHT_DOT * 2 * scale;
  return (
    <Animated.View
      style={[
        styles.abs,
        {
          left: (99 + index * 9 - THOUGHT_DOT - BUBBLE.x) * scale,
          top: (-3 - THOUGHT_DOT - BUBBLE.y) * scale,
          width: side,
          height: side,
          borderRadius: side / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

/** "…" in a little cloud above the head while the bot thinks. */
function ThoughtBubble({ color, at, scale, still }: BubbleProps) {
  const width = BUBBLE.width * scale;
  const height = BUBBLE.height * scale;
  return (
    <Animated.View
      entering={popIn}
      exiting={popOut}
      style={[
        styles.abs,
        {
          left: at(BUBBLE.x),
          top: at(BUBBLE.y),
          width,
          height,
          transformOrigin: [
            (BUBBLE.tail.x - BUBBLE.x) * scale,
            (BUBBLE.tail.y - BUBBLE.y) * scale,
            0,
          ],
        },
      ]}
    >
      <Svg
        width={width}
        height={height}
        viewBox={`${BUBBLE.x} ${BUBBLE.y} ${BUBBLE.width} ${BUBBLE.height}`}
      >
        <G fill="#ffffff">
          <Circle cx={77} cy={24} r={3.2} />
          <Circle cx={86} cy={13} r={5} />
          <Circle cx={96} cy={-6} r={10} />
          <Circle cx={109} cy={-9} r={11} />
          <Circle cx={121} cy={-3} r={9} />
          <Ellipse cx={108} cy={1} rx={19} ry={9} />
        </G>
      </Svg>
      {[0, 1, 2].map((i) => (
        <ThoughtDot key={i} index={i} color={color} scale={scale} still={still} />
      ))}
    </Animated.View>
  );
}

/** A little "z" drifting up and fading away from a sleeping bot. */
function Snore({ index, at, scale }: { index: number; at(v: number): number; scale: number }) {
  const progress = useCycle(3000, index * 1500, false);
  const style = useAnimatedStyle(() => {
    const p = progress.get();
    return {
      opacity: keyframes(p, 0, 0.9, 0),
      transform: [
        { translateX: keyframes(p, 0, 10, 16) * scale },
        { translateY: keyframes(p, 0, -16, -32) * scale },
        { scale: keyframes(p, 0.6, 1, 1.15) },
      ],
    };
  });
  // The z (7×8 units, from 82,22) with room for its stroke.
  const width = 11 * scale;
  const height = 12 * scale;
  return (
    <Animated.View style={[styles.abs, { left: at(80), top: at(20), width, height }, style]}>
      <Svg width={width} height={height} viewBox="-2 -2 11 12">
        <Path
          d="M0 0h7l-7 8h7"
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </Animated.View>
  );
}

interface CharacterProps {
  genome: BotGenome;
  mood: BotMood;
  size: number;
  pad: number;
}

/** A still character: plain SVG with the mood's face, no animated views (dense lists). */
function StillCharacter({ genome, mood, size, pad }: CharacterProps) {
  const face = FACES[mood];
  const half = genome.eyeGap / 2;
  const { eyeWidth: w, eyeHeight: h } = genome;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}
      style={[StyleSheet.absoluteFill, mood === 'sleeping' && styles.asleep]}
    >
      <Path d={BODY[genome.body]} fill={genome.color} />
      {[50 - half, 50 + half].map((cx, i) =>
        face.shape === 'pill' ? (
          <Rect
            key={cx}
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            rx={w / 2}
            fill="#ffffff"
            transform={`translate(${cx} ${EYE_Y}) rotate(${face.tilt[i] ?? 0}) scale(1 ${face.open[i] ?? 1})`}
          />
        ) : (
          <Path
            key={cx}
            d={arcPath(cx, w, face.shape)}
            fill="none"
            stroke="#ffffff"
            strokeWidth={3.6}
            strokeLinecap="round"
          />
        ),
      )}
    </Svg>
  );
}

/**
 * A living character: the eyes blink and glance around by mood, the head follows them and
 * breathes, the face shows the mood (a thought bubble while it thinks, z's while it sleeps),
 * it beams and hops when it is done and shakes its head on an error. Everything moves on the
 * UI thread; JS only picks the next glance and blink.
 */
function LiveCharacter({
  genome,
  mood,
  size,
  pad,
  halos,
  reduced,
  ring,
}: CharacterProps & { halos: boolean; reduced: boolean; ring: ReactNode }) {
  const { scale, at } = frame(size, pad);
  const expression = useExpression(mood);
  const face = FACES[expression];
  const sleeping = mood === 'sleeping';
  const half = genome.eyeGap / 2;

  const moodRef = useRef(mood);
  const lookingAt = useRef({ x: 0, y: 0 });
  const expressionRef = useRef(expression);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);
  const blink = useSharedValue(1);
  const stretch = useSharedValue(1);
  const openLeft = useSharedValue(face.open[0]);
  const openRight = useSharedValue(face.open[1]);
  const tiltLeft = useSharedValue(face.tilt[0]);
  const tiltRight = useSharedValue(face.tilt[1]);
  const lean = useSharedValue(face.head);
  const hop = useSharedValue(0);
  const breath = useSharedValue(1);

  useEffect(() => {
    moodRef.current = mood;
  }, [mood]);

  useEffect(() => {
    const was = expressionRef.current;
    expressionRef.current = expression;
    openLeft.set(withSpring(face.open[0], springs.soft));
    openRight.set(withSpring(face.open[1], springs.soft));
    tiltLeft.set(withSpring(face.tilt[0], springs.soft));
    tiltRight.set(withSpring(face.tilt[1], springs.soft));
    if (expression === 'error' && was !== 'error' && !reduced) {
      // A short shake of the head.
      const swing = (to: number) =>
        withTiming(to, { duration: 135, easing: Easing.inOut(Easing.sin) });
      lean.set(withSequence(swing(-9), swing(8), swing(-5), swing(face.head)));
    } else {
      lean.set(withSpring(face.head, springs.drift));
    }
    if (expression === 'happy' && was !== 'happy' && !reduced) {
      // A little hop of joy.
      hop.set(
        withSequence(
          withTiming(-7, { duration: 200, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 250, easing: Easing.in(Easing.quad) }),
        ),
      );
    }
  }, [expression, face, reduced, openLeft, openRight, tiltLeft, tiltRight, lean, hop]);

  // Gaze: wander, read, ponder… according to the mood. A quick glance stretches the eyes, a
  // long one often comes with a blink. Reduced motion keeps the glances (small, local
  // movements) but makes them rarer and softer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const now = moodRef.current;
      const target = nextGaze(now, genome.curiosity);
      const soft = reduced || now === 'thinking';
      const dx = target.x - lookingAt.current.x;
      const dy = target.y - lookingAt.current.y;
      lookingAt.current = target;
      if (Math.hypot(dx, dy) > 1 && now === 'idle' && Math.random() < 0.5) {
        blink.set(blinking(false));
      }
      const glance = glanceStretch(dx, soft);
      if (glance.peak > 1.01) {
        stretch.set(
          withSequence(
            withTiming(glance.peak, { duration: glance.rise, easing: Easing.out(Easing.quad) }),
            withTiming(1, { duration: glance.fall, easing: Easing.inOut(Easing.quad) }),
          ),
        );
      }
      const spring = soft ? springs.drift : springs.gaze;
      gazeX.set(withSpring(target.x, spring));
      gazeY.set(withSpring(target.y, spring));
      timer = setTimeout(step, target.delay * (reduced ? 2 : 1));
    };
    timer = setTimeout(step, rand(200, 900));
    return () => clearTimeout(timer);
  }, [reduced, genome.curiosity, gazeX, gazeY, blink, stretch]);

  // Blinks at the bot's own rhythm, sometimes twice in a row.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (moodRef.current !== 'sleeping') blink.set(blinking(Math.random() < 0.16));
          schedule();
        },
        rand(0.45, 1.55) * genome.blinkEvery * 1000,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [genome.blinkEvery, blink]);

  // Breathing: a slow, barely visible swell from the base.
  useEffect(() => {
    if (reduced) return;
    const amount = sleeping ? 1.03 : 1.018;
    const phase = (sleeping ? 5500 : 4200) / 2;
    const ease = Easing.inOut(Easing.sin);
    breath.set(
      withRepeat(
        withSequence(
          withTiming(amount, { duration: phase, easing: ease }),
          withTiming(1, { duration: phase, easing: ease }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(breath);
  }, [reduced, sleeping, breath]);

  // The head (body and eyes) breathes, then follows the eyes: it shifts and turns toward
  // where they look, on top of the face's tilt, the hop and the shake. One view, one pivot.
  const headStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: breath.get() },
      { translateX: gazeX.get() * HEAD_FOLLOW.x * scale },
      { translateY: (gazeY.get() * HEAD_FOLLOW.y + hop.get()) * scale },
      { rotate: `${gazeX.get() * HEAD_FOLLOW.turn + lean.get()}deg` },
    ],
  }));
  // The working arc and the waiting ring go where the head goes: centered on it as it looks around.
  const ringStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: gazeX.get() * HEAD_FOLLOW.x * scale },
      { translateY: (gazeY.get() * HEAD_FOLLOW.y + hop.get()) * scale },
    ],
  }));
  const eyesStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: gazeX.get() * TRAVEL.x * scale },
      { translateY: gazeY.get() * TRAVEL.y * scale },
    ],
  }));

  const eye = { genome, at, scale, blink, stretch };

  return (
    <>
      {ring && (
        <Animated.View style={[StyleSheet.absoluteFill, ringStyle]} pointerEvents="none">
          {ring}
        </Animated.View>
      )}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { transformOrigin: [at(PIVOT.x), at(PIVOT.y), 0] },
          sleeping && styles.asleep,
          headStyle,
        ]}
      >
        <Svg
          width={size}
          height={size}
          viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}
        >
          <Path d={BODY[genome.body]} fill={genome.color} />
        </Svg>
        <Animated.View style={[StyleSheet.absoluteFill, eyesStyle]}>
          {face.shape === 'pill' ? (
            <>
              <Eye cx={50 - half} open={openLeft} tilt={tiltLeft} {...eye} />
              <Eye cx={50 + half} open={openRight} tilt={tiltRight} {...eye} />
            </>
          ) : (
            [50 - half, 50 + half].map((cx) => (
              <ArcEye
                key={`${face.shape}-${cx}`}
                cx={cx}
                width={genome.eyeWidth}
                shape={face.shape === 'closed' ? 'closed' : 'happy'}
                at={at}
                scale={scale}
              />
            ))
          )}
        </Animated.View>
      </Animated.View>

      {halos && mood === 'thinking' && (
        <ThoughtBubble color={genome.color} at={at} scale={scale} still={reduced} />
      )}
      {halos &&
        sleeping &&
        !reduced &&
        [0, 1].map((i) => <Snore key={i} index={i} at={at} scale={scale} />)}
    </>
  );
}

/**
 * A bot as a little character, drawn from the same genome and faces as on the web: flat
 * colored body, two white eyes that blink at the bot's own rhythm and glance around, the head
 * following them, an expression per mood. The body is static SVG; eyes, head and halos move
 * as native views on the UI thread. `still` (or a tiny size) draws a plain, static SVG.
 */
export function BotAvatar({ seed, size = 40, mood = 'idle', badge = false, still }: Props) {
  const genome = useMemo(() => botGenome(seed), [seed]);
  const reduced = useReducedMotion();
  const quiet = still ?? size < 20;
  // State halos, the thought bubble and the z's on larger avatars.
  const halos = size >= 36;
  const pad = halos ? 14 : 2;
  const { scale, at } = frame(size, pad);
  const halo = { size, pad, color: genome.color, reduced };
  const character = { genome, mood, size, pad };
  const dot = 24 * scale;
  const ring = !halos ? null : mood === 'working' ? (
    <WorkingArc {...halo} />
  ) : mood === 'waiting' ? (
    <WaitingRing {...halo} />
  ) : null;

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {quiet ? (
        <>
          {ring}
          <StillCharacter {...character} />
        </>
      ) : (
        <LiveCharacter {...character} halos={halos} reduced={reduced} ring={ring} />
      )}

      {(badge || mood === 'error') && (
        <View
          style={[
            styles.badge,
            {
              left: at(86) - dot / 2 - 2.5 * scale,
              top: at(12) - dot / 2 - 2.5 * scale,
              width: dot + 5 * scale,
              height: dot + 5 * scale,
              borderRadius: dot,
              borderWidth: 2.5 * scale,
            },
          ]}
        />
      )}
    </View>
  );
}

/** A team: up to three member characters huddled together. */
export function TeamAvatar({ seeds, size = 32 }: { seeds: string[]; size?: number }) {
  const members = seeds.slice(0, 3);
  if (members.length <= 1) {
    return (
      <View style={[styles.center, { width: size, height: size }]}>
        {members[0] ? (
          <BotAvatar seed={members[0]} size={size * 0.78} still />
        ) : (
          // A team without bots yet: an empty seat.
          <View
            style={[
              styles.seat,
              { width: size * 0.7, height: size * 0.7, borderRadius: size * 0.35 },
            ]}
          />
        )}
      </View>
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
    <View style={{ width: size, height: size }}>
      {members.map((seed, i) => (
        <View
          key={seed}
          style={[
            styles.member,
            spots[i],
            { width: small + 4, height: small + 4, borderRadius: small },
          ]}
        >
          <BotAvatar seed={seed} size={small} still />
        </View>
      ))}
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    abs: { position: 'absolute' },
    eye: { position: 'absolute', backgroundColor: '#ffffff' },
    asleep: { opacity: 0.72 },
    badge: { position: 'absolute', backgroundColor: colors.error, borderColor: colors.background },
    center: { alignItems: 'center', justifyContent: 'center' },
    seat: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong },
    member: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      margin: -2,
    },
  }),
);
