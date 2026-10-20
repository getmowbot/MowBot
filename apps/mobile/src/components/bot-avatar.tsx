import { type BodyShape, type BotGenome, botGenome } from '@mowbot/design';
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import type { BotMood } from '../lib/bot-mood';
import { colors, springs } from '../theme';

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
  side: -1 | 1;
  genome: BotGenome;
  at(v: number): number;
  scale: number;
  blink: SharedValue<number>;
  openness: SharedValue<number>;
  tilt: SharedValue<number>;
}

function Eye({ cx, side, genome, at, scale, blink, openness, tilt }: EyeProps) {
  const style = useAnimatedStyle(() => ({
    transform: [
      // Worried brows when something went wrong.
      { rotate: `${side * -tilt.get()}deg` },
      { scaleY: blink.get() * openness.get() },
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

/** A continuous turn (working arc, thinking dots); still when motion is reduced. */
function useSpin(period: number, reduced: boolean) {
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    turn.set(withRepeat(withTiming(360, { duration: period, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(turn);
  }, [period, reduced, turn]);
  return useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
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

function ThinkingDots({ size, pad, color, reduced }: HaloProps) {
  const spin = useSpin(3600, reduced);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, spin]} pointerEvents="none">
      <Svg width={size} height={size} viewBox={`${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`}>
        {[0, 120, 240].map((angle, i) => (
          <Circle
            key={angle}
            cx={50 + 58 * Math.cos((angle * Math.PI) / 180)}
            cy={50 + 58 * Math.sin((angle * Math.PI) / 180)}
            r={4 - i * 0.9}
            fill={color}
            opacity={0.95 - i * 0.25}
          />
        ))}
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

/**
 * A bot as a little character, drawn from the same genome as on the web: flat colored body,
 * two white pill eyes that blink at the bot's own rhythm and glance around, an expression
 * per mood. The body is static SVG; eyes and halos move as native views on the UI thread.
 */
export function BotAvatar({ seed, size = 40, mood = 'idle', badge = false, still }: Props) {
  const genome = useMemo(() => botGenome(seed), [seed]);
  const reduced = useReducedMotion();
  const quiet = still ?? size < 20;
  const halos = size >= 36;
  const pad = halos ? 14 : 2;
  const { scale, at } = frame(size, pad);
  const half = genome.eyeGap / 2;
  const sleeping = mood === 'sleeping';

  const moodRef = useRef(mood);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);
  const blink = useSharedValue(1);
  const openness = useSharedValue(OPENNESS[mood]);
  const tilt = useSharedValue(0);
  const breath = useSharedValue(1);

  useEffect(() => {
    moodRef.current = mood;
    openness.set(withSpring(OPENNESS[mood], springs.soft));
    tilt.set(withSpring(mood === 'error' ? 16 : 0, springs.soft));
  }, [mood, openness, tilt]);

  // Gaze: wander, read, ponder… according to the mood. Reduced motion keeps the glances
  // (small, local movements) but makes them rarer and softer.
  useEffect(() => {
    if (quiet) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const target = nextGaze(moodRef.current, genome.curiosity);
      const spring = reduced || moodRef.current === 'thinking' ? springs.drift : springs.gaze;
      gazeX.set(withSpring(target.x, spring));
      gazeY.set(withSpring(target.y, spring));
      timer = setTimeout(step, target.delay * (reduced ? 2 : 1));
    };
    timer = setTimeout(step, rand(200, 900));
    return () => clearTimeout(timer);
  }, [quiet, reduced, genome.curiosity, gazeX, gazeY]);

  // Blinks at the bot's own rhythm, sometimes twice in a row.
  useEffect(() => {
    if (quiet) return;
    let timer: ReturnType<typeof setTimeout>;
    const close = () => withTiming(0.08, { duration: 70, easing: Easing.inOut(Easing.quad) });
    const open = () => withTiming(1, { duration: 130, easing: Easing.inOut(Easing.quad) });
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (moodRef.current !== 'sleeping') {
            blink.set(
              Math.random() < 0.16
                ? withSequence(close(), open(), close(), open())
                : withSequence(close(), open()),
            );
          }
          schedule();
        },
        rand(0.45, 1.55) * genome.blinkEvery * 1000,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [quiet, genome.blinkEvery, blink]);

  // Breathing: a slow, barely visible swell from the base.
  useEffect(() => {
    if (quiet || reduced) return;
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
  }, [quiet, reduced, sleeping, breath]);

  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ scale: breath.get() }] }));
  const eyesStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: gazeX.get() * TRAVEL.x * scale },
      { translateY: gazeY.get() * TRAVEL.y * scale },
    ],
  }));

  const viewBox = `${-pad} ${-pad} ${100 + pad * 2} ${100 + pad * 2}`;
  const halo = { size, pad, color: genome.color, reduced };
  const eye = { genome, at, scale, blink, openness, tilt };
  const dot = 24 * scale;

  return (
    <View style={{ width: size, height: size }} pointerEvents="none">
      {halos && mood === 'working' && <WorkingArc {...halo} />}
      {halos && mood === 'thinking' && <ThinkingDots {...halo} />}
      {halos && mood === 'waiting' && <WaitingRing {...halo} />}

      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { transformOrigin: [at(50), at(92), 0], opacity: sleeping ? 0.72 : 1 },
          bodyStyle,
        ]}
      >
        <Svg width={size} height={size} viewBox={viewBox}>
          <Path d={BODY[genome.body]} fill={genome.color} />
          {sleeping &&
            [50 - half, 50 + half].map((cx) => {
              const w = genome.eyeWidth;
              return (
                <Path
                  key={cx}
                  d={`M${cx - w * 0.85} ${EYE_Y} Q${cx} ${EYE_Y + w * 1.1} ${cx + w * 0.85} ${EYE_Y}`}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth={3.4}
                  strokeLinecap="round"
                />
              );
            })}
        </Svg>
        {!sleeping && (
          <Animated.View style={[StyleSheet.absoluteFill, eyesStyle]}>
            <Eye cx={50 - half} side={-1} {...eye} />
            <Eye cx={50 + half} side={1} {...eye} />
          </Animated.View>
        )}
      </Animated.View>

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

const styles = StyleSheet.create({
  eye: { position: 'absolute', backgroundColor: '#ffffff' },
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
});
