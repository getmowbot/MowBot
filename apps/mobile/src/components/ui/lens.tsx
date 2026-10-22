import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  RadialGradient,
  Rect,
  Stop,
  LinearGradient as SvgGradient,
} from 'react-native-svg';
import { isIOS } from '../../lib/platform';
import { colors, currentScheme, themed } from '../../theme';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** One turn of the light along the edge: slow, quicker while the user writes (as on the web). */
const TURN_MS = { idle: 6_000, focused: 3_500 } as const;
/**
 * The light's tail, as parts of the edge: overlapping, faint each, they brighten towards its
 * head without a visible step.
 */
const TAIL = [0.04, 0.08, 0.12, 0.16, 0.2, 0.24, 0.28, 0.32] as const;

type Size = { width: number; height: number };

/**
 * A color as react-native-svg needs it: native iOS and Android ignore the alpha of an `rgba()`
 * in gradient stops and strokes (the edge turned opaque white), so it becomes an opacity.
 */
function svgColor(color: string): { color: string; opacity: number } {
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(color);
  if (!rgba) return { color, opacity: 1 };
  return { color: `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`, opacity: Number(rgba[4]) };
}

/** An id usable in an SVG `url(#…)` (React's have colons). */
const useSvgId = () => useId().replace(/[^a-zA-Z0-9_-]/g, '');

/**
 * The web's message field, natively: a lens of glass, very round, bulging (a shine on top, depth
 * under, a soft shadow), with a single edge lit from above and a slow light running along it,
 * brighter and quicker while `focused`. Blurs what scrolls under it on iOS; Android keeps it
 * opaque.
 */
export function Lens({
  focused,
  radius = 26,
  style,
  children,
}: {
  focused: boolean;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [size, setSize] = useState<Size | null>(null);
  return (
    <View style={[styles.lift, { borderRadius: radius }]}>
      <View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSize((was) =>
            was?.width === width && was.height === height ? was : { width, height },
          );
        }}
        style={[styles.body, { borderRadius: radius }]}
      >
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          {isIOS && (
            <BlurView
              tint={currentScheme() === 'light' ? 'light' : 'dark'}
              intensity={40}
              style={StyleSheet.absoluteFill}
            />
          )}
          <View style={[StyleSheet.absoluteFill, styles.fill]} />
          <LinearGradient
            colors={[colors.lensTop, colors.lensBottom]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient colors={['transparent', colors.lensDepth]} style={styles.depth} />
          {size && <Shine {...size} />}
        </View>
        {/* Its own layer: above the glass's, on the web too. */}
        <View style={style}>{children}</View>
      </View>
      {size && <Edge {...size} radius={radius} focused={focused} />}
    </View>
  );
}

/**
 * A soft highlight across the top, as on a bulging glass: it fades out before its own bounds,
 * so no shape shows inside the field.
 */
function Shine({ width, height }: Size) {
  const id = useSvgId();
  const w = width * 0.88;
  const h = height * 0.6;
  const shine = svgColor(colors.lensShine);
  return (
    <Svg width={w} height={h} style={[styles.shine, { left: width * 0.06 }]}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="0%" rx="50%" ry="100%">
          <Stop offset="0" stopColor={shine.color} stopOpacity={shine.opacity * 0.5} />
          <Stop offset="1" stopColor={shine.color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={w} height={h} fill={`url(#${id})`} />
    </Svg>
  );
}

/** The field's one edge: lit from above, quiet down its sides; and the light going round it. */
function Edge({ width, height, radius, focused }: Size & { radius: number; focused: boolean }) {
  const id = useSvgId();
  const reduced = useReducedMotion();
  const r = Math.min(radius, height / 2) - 0.5;
  const perimeter = 2 * (width - 1 + (height - 1)) - 8 * r + 2 * Math.PI * r;
  const turns = useSharedValue(0);
  const shown = useSharedValue(focused ? 1 : 0.6);

  useEffect(() => {
    shown.set(withTiming(focused ? 1 : 0.6, { duration: 300 }));
    if (reduced) return;
    // Goes on from where the light is, at the new pace.
    const from = turns.get() % 1;
    turns.set(from);
    turns.set(
      withRepeat(
        withTiming(from + 1, {
          duration: focused ? TURN_MS.focused : TURN_MS.idle,
          easing: Easing.linear,
        }),
        -1,
      ),
    );
    return () => cancelAnimation(turns);
  }, [focused, reduced, turns, shown]);

  const fade = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const shape = { x: 0.5, y: 0.5, width: width - 1, height: height - 1, rx: r, ry: r };
  const rim = svgColor(colors.lensRim);
  const side = svgColor(focused ? colors.borderStrong : colors.border);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={rim.color} stopOpacity={rim.opacity} />
            <Stop offset="0.5" stopColor={side.color} stopOpacity={side.opacity} />
          </SvgGradient>
        </Defs>
        <Rect {...shape} fill="none" stroke={`url(#${id})`} strokeWidth={1} />
      </Svg>
      {!reduced && (
        <Animated.View style={[StyleSheet.absoluteFill, fade]}>
          <Svg width={width} height={height}>
            {TAIL.map((part) => (
              <TailPart key={part} part={part} perimeter={perimeter} turns={turns} shape={shape} />
            ))}
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}

function TailPart({
  part,
  perimeter,
  turns,
  shape,
}: {
  part: number;
  perimeter: number;
  turns: SharedValue<number>;
  shape: { x: number; y: number; width: number; height: number; rx: number; ry: number };
}) {
  const length = part * perimeter;
  const beam = svgColor(colors.lensBeam);
  // Every part's head at the same point: the overlap brightens towards it.
  const props = useAnimatedProps(() => ({
    strokeDashoffset: length - (turns.get() % 1) * perimeter,
  }));
  return (
    <AnimatedRect
      {...shape}
      fill="none"
      stroke={beam.color}
      strokeOpacity={beam.opacity * 0.14}
      strokeWidth={1}
      strokeDasharray={[length, perimeter - length]}
      animatedProps={props}
    />
  );
}

const styles = themed(() =>
  StyleSheet.create({
    lift: {
      shadowColor: colors.lensShadow,
      shadowOpacity: currentScheme() === 'light' ? 0.14 : 0.6,
      shadowRadius: 22,
      shadowOffset: { width: 0, height: 12 },
      elevation: 3,
    },
    body: { overflow: 'hidden' },
    fill: { backgroundColor: isIOS ? colors.lensFill : colors.lensFillOpaque },
    depth: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 18 },
    shine: { position: 'absolute', top: 0 },
  }),
);
