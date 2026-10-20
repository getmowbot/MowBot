import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';

/** iOS 26+ draws Liquid Glass; older iOS falls back to blur, Android to Material surfaces. */
export const hasLiquidGlass = isIOS && isLiquidGlassAvailable();

/** Liquid Glass unless the user asked iOS to reduce transparency. */
export function useLiquidGlass(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!hasLiquidGlass) return;
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduced,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return hasLiquidGlass && !reduced;
}
