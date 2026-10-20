import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, type } from '../../theme';

interface Props {
  children: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /** Off: plain muted text. */
  active?: boolean;
  color?: string;
}

const BAND = 0.45;

/** Text "in progress", swept by a soft reflection (still when motion is reduced). */
export function ShimmerText({
  children,
  style,
  numberOfLines = 1,
  active = true,
  color = colors.textMuted,
}: Props) {
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const sweep = useSharedValue(0);

  const moving = active && !reduced && width > 0;
  useEffect(() => {
    if (!moving) return;
    sweep.set(0);
    sweep.set(
      withRepeat(withTiming(1, { duration: 1900, easing: Easing.inOut(Easing.quad) }), -1, false),
    );
    return () => cancelAnimation(sweep);
  }, [moving, sweep]);

  const band = useAnimatedStyle(() => ({
    transform: [{ translateX: -width * BAND + sweep.get() * width * (1 + BAND) }],
  }));

  const text = (
    <Text numberOfLines={numberOfLines} style={[type.footnote, style, { color }]}>
      {children}
    </Text>
  );
  if (!moving) {
    return (
      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={styles.row}>
        {text}
      </View>
    );
  }

  return (
    <MaskedView style={styles.row} maskElement={text}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ backgroundColor: color }}
      >
        {/* Invisible copy: gives the mask its size. */}
        <Text numberOfLines={numberOfLines} style={[type.footnote, style, styles.hidden]}>
          {children}
        </Text>
        <Animated.View style={[styles.band, { width: width * BAND }, band]}>
          <LinearGradient
            colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.95)', 'rgba(255,255,255,0)']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  row: { flexShrink: 1, alignSelf: 'flex-start', maxWidth: '100%' },
  hidden: { opacity: 0 },
  band: { position: 'absolute', top: 0, bottom: 0, left: 0 },
});
