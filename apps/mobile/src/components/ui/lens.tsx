import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, {
  Defs,
  Path,
  RadialGradient,
  Rect,
  Stop,
  LinearGradient as SvgGradient,
} from 'react-native-svg';
import { isIOS } from '../../lib/platform';
import { colors, currentScheme, themed } from '../../theme';

/** One turn of the light along the edge: slow, quicker while the user writes (as on the web). */
const TURN_MS = { idle: 6_000, focused: 3_500 } as const;

/**
 * The web's light along the edge, a conic gradient: nothing on most of the turn, then rising to
 * its brightest at 310° and fading out by 360° (0° up, clockwise).
 */
function beamAt(degrees: number): number {
  if (degrees < 250) return 0;
  return degrees < 310 ? (degrees - 250) / 60 : (360 - degrees) / 50;
}
/** The conic gradient drawn as thin wedges, fine enough that no step shows on the edge. */
const WEDGE = 3;

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
 * under, a soft shadow), with a single edge lit from above and a slow light turning along it,
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

/** The field's one edge: lit from above, quiet down its sides; and the light turning along it. */
function Edge({ width, height, radius, focused }: Size & { radius: number; focused: boolean }) {
  const id = useSvgId();
  const r = Math.min(radius, height / 2) - 0.5;
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
        <Rect
          x={0.5}
          y={0.5}
          width={width - 1}
          height={height - 1}
          rx={r}
          ry={r}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={1}
        />
      </Svg>
      <Beam width={width} height={height} radius={radius} focused={focused} />
    </View>
  );
}

/**
 * The light along the edge, as on the web: a conic gradient turning behind the field, seen only
 * through its 1 px edge.
 */
function Beam({ width, height, radius, focused }: Size & { radius: number; focused: boolean }) {
  const reduced = useReducedMotion();
  const turn = useSharedValue(0);
  const shown = useSharedValue(focused ? 1 : 0.6);

  useEffect(() => {
    shown.set(withTiming(focused ? 1 : 0.6, { duration: 300 }));
    if (reduced) return;
    // Goes on from where the light is, at the new pace.
    const from = turn.get() % 360;
    turn.set(from);
    turn.set(
      withRepeat(
        withTiming(from + 360, {
          duration: focused ? TURN_MS.focused : TURN_MS.idle,
          easing: Easing.linear,
        }),
        -1,
      ),
    );
    return () => cancelAnimation(turn);
  }, [focused, reduced, turn, shown]);

  const turning = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
  const fade = useAnimatedStyle(() => ({ opacity: shown.get() }));
  // A square around the field's center, wide enough to cover its corners at any angle.
  const side = Math.ceil(Math.hypot(width, height)) + 2;
  // The web's MaskedView draws only its mask: no light there (the app is iOS and Android).
  if (reduced || Platform.OS === 'web') return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, fade]}>
      <MaskedView
        style={StyleSheet.absoluteFill}
        maskElement={<View style={[styles.ring, { borderRadius: radius }]} />}
      >
        <Animated.View
          style={[
            styles.conic,
            { width: side, height: side, left: (width - side) / 2, top: (height - side) / 2 },
            turning,
          ]}
        >
          <Conic side={side} />
        </Animated.View>
      </MaskedView>
    </Animated.View>
  );
}

/** The conic gradient itself, drawn once: thin wedges from the center, each at its brightness. */
function Conic({ side }: { side: number }) {
  const beam = svgColor(colors.lensBeam);
  const wedges = useMemo(() => {
    const c = side / 2;
    // Past the corners: a wedge's straight end stays outside the square.
    const reach = side;
    const at = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return `${(c + reach * Math.sin(a)).toFixed(2)} ${(c - reach * Math.cos(a)).toFixed(2)}`;
    };
    const out: { d: string; opacity: number }[] = [];
    for (let from = 250; from < 360; from += WEDGE) {
      const opacity = beamAt(from + WEDGE / 2);
      if (opacity > 0) out.push({ d: `M${c} ${c}L${at(from)}L${at(from + WEDGE)}Z`, opacity });
    }
    return out;
  }, [side]);
  return (
    <Svg width={side} height={side}>
      {wedges.map((wedge) => (
        <Path
          key={wedge.d}
          d={wedge.d}
          fill={beam.color}
          fillOpacity={beam.opacity * wedge.opacity}
        />
      ))}
    </Svg>
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
    // What shows the light: only the field's 1 px edge.
    ring: { flex: 1, borderWidth: 1, borderColor: '#000000' },
    conic: { position: 'absolute' },
  }),
);
