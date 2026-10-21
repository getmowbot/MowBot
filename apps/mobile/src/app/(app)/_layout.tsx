import { Stack } from 'expo-router';
import { usePushNotifications } from '../../lib/push';
import { colors } from '../../theme';

/** Registers this phone for pushes and opens tapped ones (inside the stack it navigates). */
function PushNotifications() {
  usePushNotifications();
  return null;
}

/**
 * Everything behind sign-in: the tabs, then screens pushed over them. Pushed screens show a
 * native header through `Screen` (components/screen.tsx); the chat draws its own.
 */
export default function AppLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.text,
          headerTitleStyle: { color: colors.text },
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: colors.background },
        }}
      />
      <PushNotifications />
    </>
  );
}
