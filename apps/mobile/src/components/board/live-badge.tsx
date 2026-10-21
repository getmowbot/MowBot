import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '../../theme';
import { T } from '../ui/text';

const DOT = 6;

/**
 * "Live" on a home card an automation keeps up to date: a white dot sending out a soft ring
 * on the UI thread (still when motion is reduced).
 */
export function LiveBadge() {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (reduced) return;
    pulse.set(0);
    pulse.set(
      withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);
  const ring = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - pulse.get()),
    transform: [{ scale: 1 + pulse.get() * 1.4 }],
  }));

  return (
    <View
      accessible
      accessibilityLabel={`${t('board.canvas.live')} · ${t('board.canvas.liveHint')}`}
      style={styles.badge}
    >
      <View style={styles.dotBox}>
        {reduced ? null : <Animated.View style={[styles.dot, styles.ring, ring]} />}
        <View style={styles.dot} />
      </View>
      <T variant="caption" style={styles.label}>
        {t('board.canvas.live')}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  dotBox: { width: DOT, height: DOT },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.accentStrong },
  ring: { position: 'absolute' },
  label: { color: colors.text, fontWeight: '600' },
});
