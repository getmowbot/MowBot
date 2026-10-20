import { Stack } from 'expo-router';
import { hasLiquidGlass, isIOS } from '../lib/platform';
import { colors } from '../theme';

/**
 * The native header of each tab. iOS: a large title that collapses into a translucent bar
 * (Liquid Glass scroll edge on iOS 26, dark blur before). Android: a Material top app bar on
 * the app background.
 */
export function TabStack({ title }: { title: string }) {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: isIOS,
        headerTransparent: isIOS,
        headerBlurEffect: isIOS && !hasLiquidGlass ? 'systemChromeMaterialDark' : undefined,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: isIOS ? 'transparent' : colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text },
        headerLargeTitleStyle: { color: colors.text },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title }} />
    </Stack>
  );
}
