import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import { type StyleProp, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { isAndroid, useLiquidGlass } from '../../lib/platform';
import { colors, shape } from '../../theme';

export interface SurfaceProps extends ViewProps {
  /** `card`: content blocks; `bar`: floating chrome (header, composer) over scrolling content. */
  variant?: 'card' | 'bar';
  radius?: number;
  /** Liquid Glass reacts to touches (buttons, the composer). */
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The app's dark glass. iOS 26: Liquid Glass, materializing on mount (fading a glass view's
 * opacity would kill the effect). Older iOS: blur for bars, flat surfaces for cards. Android:
 * Material 3 tonal surfaces, no shadow glow.
 */
export function Surface({
  variant = 'card',
  radius = variant === 'bar' ? shape.bar : shape.card,
  interactive = false,
  style,
  children,
  ...props
}: SurfaceProps) {
  const glass = useLiquidGlass();
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(true), []);

  if (glass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle={{
          style: shown ? 'regular' : 'none',
          animate: true,
          animationDuration: 0.35,
        }}
        colorScheme="dark"
        isInteractive={interactive}
        style={[{ borderRadius: radius }, style]}
      >
        {children}
      </GlassView>
    );
  }

  if (isAndroid) {
    const backgroundColor =
      variant === 'bar' ? colors.surfaceContainerHigh : colors.surfaceContainer;
    return (
      // Clipped so row ripples follow the rounded shape.
      <View {...props} style={[{ borderRadius: radius, backgroundColor }, styles.clip, style]}>
        {children}
      </View>
    );
  }

  if (variant === 'bar') {
    return (
      <View {...props} style={[styles.hairline, { borderRadius: radius }, styles.clip, style]}>
        <BlurView tint="systemChromeMaterialDark" intensity={80} style={StyleSheet.absoluteFill} />
        {children}
      </View>
    );
  }

  return (
    <View
      {...props}
      style={[styles.hairline, { borderRadius: radius, backgroundColor: colors.surface }, style]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  hairline: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderCurve: 'continuous',
  },
  clip: { overflow: 'hidden' },
});
