import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { isAndroid } from '../../lib/platform';
import { colors, springs, type } from '../../theme';
import { Surface } from './surface';

interface Option<V extends string> {
  value: V;
  label: string;
}

interface Props<V extends string> {
  options: readonly Option<V>[];
  value: V;
  onChange(value: V): void;
  label?: string;
}

const HEIGHT = isAndroid ? 40 : 36;
const INSET = isAndroid ? 0 : 3;

/** Ink follows the pill: black while it sits under the label, muted once it has left. */
function OptionLabel({
  label,
  index,
  position,
}: {
  label: string;
  index: number;
  position: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    color: interpolateColor(
      Math.min(1, Math.abs(position.get() - index)),
      [0, 1],
      [colors.accentInk, colors.textMuted],
    ),
  }));
  return (
    <Animated.Text numberOfLines={1} style={[type.footnote, styles.label, style]}>
      {label}
    </Animated.Text>
  );
}

/**
 * A segmented control: a white pill (black ink) glides to the choice on a critically damped
 * spring. Glass capsule on iOS, Material 3 outlined segmented button on Android.
 */
export function Segmented<V extends string>({ options, value, onChange, label }: Props<V>) {
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const position = useSharedValue(index);
  useEffect(() => {
    position.set(withSpring(index, springs.soft));
  }, [index, position]);

  const segment = width > 0 ? (width - INSET * 2) / options.length : 0;
  const pill = useAnimatedStyle(() => ({
    transform: [{ translateX: position.get() * segment }],
  }));

  const select = (next: V) => {
    if (next === value) return;
    void Haptics.selectionAsync();
    onChange(next);
  };

  const content = (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.track}
    >
      {segment > 0 && (
        <Animated.View
          style={[styles.pill, { width: segment, left: INSET, top: INSET, bottom: INSET }, pill]}
        />
      )}
      {options.map((option, i) => (
        <Pressable
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: i === index }}
          onPress={() => select(option.value)}
          android_ripple={{ color: i === index ? colors.rippleOnAccent : colors.ripple }}
          style={styles.option}
        >
          <OptionLabel label={option.label} index={i} position={position} />
        </Pressable>
      ))}
    </View>
  );

  if (isAndroid) return <View style={styles.outlined}>{content}</View>;
  return <Surface radius={HEIGHT / 2 + INSET}>{content}</Surface>;
}

const styles = StyleSheet.create({
  outlined: {
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    overflow: 'hidden',
  },
  track: { flexDirection: 'row', height: HEIGHT + INSET * 2, padding: INSET },
  pill: {
    position: 'absolute',
    borderRadius: 9999,
    backgroundColor: colors.accentStrong,
  },
  option: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  label: { fontWeight: '600' },
});
