import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode, useEffect } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { isAndroid } from '../../lib/platform';
import { colors, themed } from '../../theme';

/** The web's sweep: quick, then settling (cubic-bezier(0.22, 0.7, 0.2, 1)). */
const SWEEP = { duration: 800, easing: Easing.bezier(0.22, 0.7, 0.2, 1) };

/**
 * The primary round button's face, as on the web: a pebble lit from above (a lighter top, a
 * bright rim, a shade under), white on dark and ink on light, and a reflection sweeping across
 * each time `sweep` changes. Put it in a Touchable (or a gesture) for the press.
 */
export function Pebble({
  size,
  sweep = 0,
  disabled = false,
  style,
  children,
}: {
  size: number;
  /** Change it to run the reflection across once (it became pressable, it was pressed). */
  sweep?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const shift = useSharedValue(-1);
  useEffect(() => {
    if (sweep === 0 || reduced) return;
    shift.set(-1);
    shift.set(withTiming(1, SWEEP));
  }, [sweep, reduced, shift]);
  const sheen = useAnimatedStyle(() => ({
    transform: [{ translateX: shift.get() * size * 1.3 }],
  }));
  const radius = isAndroid ? 14 : size / 2;
  return (
    <View
      style={[
        styles.lift,
        { width: size, height: size, borderRadius: radius },
        disabled && styles.disabled,
        style,
      ]}
    >
      <View style={[styles.face, { borderRadius: radius }]}>
        <LinearGradient
          colors={[colors.pebbleTop, colors.pebbleBottom]}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[StyleSheet.absoluteFill, sheen]} pointerEvents="none">
          <LinearGradient
            colors={['transparent', colors.pebbleSheen, 'transparent']}
            locations={[0.3, 0.46, 0.62]}
            start={{ x: 0, y: 0.32 }}
            end={{ x: 1, y: 0.68 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <View style={[styles.rim, { borderRadius: radius }]} pointerEvents="none" />
        <View style={styles.content}>{children}</View>
      </View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    // Its shadow under: lit from above.
    lift: {
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
    },
    face: {
      flex: 1,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    rim: {
      ...StyleSheet.absoluteFill,
      borderWidth: 1,
      borderColor: 'transparent',
      borderTopColor: colors.pebbleRim,
      borderBottomColor: colors.pebbleUnder,
    },
    // Its own layer: above the light, on the web too.
    content: { alignItems: 'center', justifyContent: 'center' },
    disabled: { opacity: 0.4 },
  }),
);
