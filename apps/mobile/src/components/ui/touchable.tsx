import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { isAndroid } from '../../lib/platform';
import { colors, springs } from '../../theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface TouchableProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Android ripple over a light surface (white buttons) needs a dark ripple. */
  onAccent?: boolean;
  /** Ripple spreading past the bounds (icon buttons). */
  borderless?: boolean;
}

/**
 * Press feedback per platform: a Material ripple on Android, a slight critically damped
 * press-in (no bounce back) on iOS.
 */
export function Touchable({
  style,
  onAccent = false,
  borderless = false,
  onPressIn,
  onPressOut,
  disabled,
  ...props
}: TouchableProps) {
  const reduced = useReducedMotion();
  const pressed = useSharedValue(0);
  // Scale only: lowering the opacity of a parent breaks Liquid Glass.
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.get() * 0.03 }],
  }));

  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      android_ripple={
        disabled
          ? undefined
          : {
              color: onAccent ? colors.rippleOnAccent : colors.ripple,
              borderless,
              foreground: true,
            }
      }
      onPressIn={(event) => {
        if (!isAndroid) pressed.set(reduced ? 1 : withSpring(1, springs.snappy));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!isAndroid) pressed.set(reduced ? 0 : withSpring(0, springs.soft));
        onPressOut?.(event);
      }}
      style={[style, !isAndroid && animated]}
    />
  );
}
