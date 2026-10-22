import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useState } from 'react';
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
import Svg, { Defs, Ellipse, RadialGradient, Rect, Stop } from 'react-native-svg';
import { isIOS } from '../../lib/platform';
import { colors, currentScheme, themed } from '../../theme';

const AnimatedRect = Animated.createAnimatedComponent(Rect);

/** One turn of the light along the edge: slow, quicker while the user writes (as on the web). */
const TURN_MS = { idle: 6_000, focused: 3_500 } as const;
/** The light's tail, as parts of the edge: overlapping, they fade from its head backwards. */
const TAIL = [0.3, 0.18, 0.08] as const;

/**
 * The web's message field, natively: a lens of glass, very round, bulging (a shine on top, depth
 * under, a soft shadow), with a slow light running along its edge, brighter and quicker while
 * `focused`. Blurs what scrolls under it on iOS; Android keeps it opaque.
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
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return (
    <View style={[styles.lift, { borderRadius: radius }]}>
      <View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setSize((was) =>
            was?.width === width && was.height === height ? was : { width, height },
          );
        }}
        style={[styles.body, { borderRadius: radius }, focused && styles.bodyFocused]}
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
          {size && <Shine width={size.width} height={size.height} />}
          <View style={[styles.rim, { borderRadius: radius }]} />
        </View>
        {/* Its own layer: above the glass's, on the web too. */}
        <View style={style}>{children}</View>
      </View>
      {size && <Beam {...size} radius={radius} focused={focused} />}
    </View>
  );
}

/** A soft highlight across the top, as on a bulging glass. */
function Shine({ width, height }: { width: number; height: number }) {
  const w = width * 0.84;
  const h = height * 0.55;
  return (
    <Svg width={w} height={h} style={[styles.shine, { left: width * 0.08 }]}>
      <Defs>
        <RadialGradient id="shine" cx="50%" cy="0%" rx="120%" ry="100%">
          <Stop offset="0" stopColor={colors.lensShine} stopOpacity={0.55} />
          <Stop offset="0.7" stopColor={colors.lensShine} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={w / 2} cy={0} rx={w} ry={h} fill="url(#shine)" />
    </Svg>
  );
}

/** The light along the edge: a comet going round, its tail fading. */
function Beam({
  width,
  height,
  radius,
  focused,
}: {
  width: number;
  height: number;
  radius: number;
  focused: boolean;
}) {
  const reduced = useReducedMotion();
  // Plain numbers for the worklets (never the theme's live colors).
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
  return (
    <Animated.View style={[StyleSheet.absoluteFill, fade]} pointerEvents="none">
      <Svg width={width} height={height}>
        {TAIL.map((part) => (
          <TailPart
            key={part}
            part={part}
            perimeter={perimeter}
            turns={turns}
            width={width}
            height={height}
            r={r}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

function TailPart({
  part,
  perimeter,
  turns,
  width,
  height,
  r,
}: {
  part: number;
  perimeter: number;
  turns: SharedValue<number>;
  width: number;
  height: number;
  r: number;
}) {
  const length = part * perimeter;
  // Every part's head at the same point: the overlap brightens towards it.
  const props = useAnimatedProps(() => ({
    strokeDashoffset: length - (turns.get() % 1) * perimeter,
  }));
  return (
    <AnimatedRect
      x={0.5}
      y={0.5}
      width={width - 1}
      height={height - 1}
      rx={r}
      ry={r}
      fill="none"
      stroke={colors.lensBeam}
      strokeOpacity={0.4}
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
    body: {
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
    },
    bodyFocused: { borderColor: colors.borderStrong },
    fill: { backgroundColor: isIOS ? colors.lensFill : colors.lensFillOpaque },
    depth: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 18 },
    shine: { position: 'absolute', top: 1 },
    rim: {
      ...StyleSheet.absoluteFill,
      borderWidth: 1,
      borderColor: 'transparent',
      borderTopColor: colors.lensRim,
    },
  }),
);
