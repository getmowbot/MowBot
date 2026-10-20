import { BlurView } from 'expo-blur';
import { GlassView } from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import { type StyleProp, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';
import { isAndroid, useLiquidGlass } from '../../lib/platform';
import { colors, shape } from '../../theme';

export interface SurfaceProps extends ViewProps {
  /**
   * `card`: content blocks, always flat. `bar`: floating chrome over the content (the message
   * field, the chat's back, options and title): the only Liquid Glass of the app.
   */
  variant?: 'card' | 'bar';
  radius?: number;
  /** Liquid Glass reacts to touches (buttons, the composer). */
  interactive?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * The app's surfaces. Bars: Liquid Glass on iOS 26, materializing on mount (fading a glass
 * view's opacity would kill the effect), blur on older iOS. Cards: flat everywhere, so glass stays
 * for the few controls floating over content. Android: Material 3 tonal surfaces, no glow.
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

  if (glass && variant === 'bar') {
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
        <BlurView
          tint="systemChromeMaterialDark"
          intensity={80}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
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
