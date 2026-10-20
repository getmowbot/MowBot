import { QueryClientProvider } from '@tanstack/react-query';
import { useLocales } from 'expo-localization';
import { DarkTheme, Stack, type Theme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { OptionsHost } from '../components/ui/options-host';
import i18n, { storedPreference } from '../i18n';
import { resolveLanguage } from '../i18n/catalog';
import { useServerEvents } from '../lib/events';
import { queryClient } from '../lib/queries';
import { restoreSession, useSession } from '../lib/session';
import { colors } from '../theme';

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(colors.background);

const theme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accentStrong,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
    notification: colors.error,
  },
};

function ServerEvents() {
  useServerEvents();
  return null;
}

/** Follows the phone's language while the user has not picked one. */
function useDeviceLanguage() {
  const locales = useLocales();
  const code = locales[0]?.languageCode;
  useEffect(() => {
    if (storedPreference() !== 'system') return;
    const next = resolveLanguage('system', code);
    if (next !== i18n.language) void i18n.changeLanguage(next);
  }, [code]);
}

export default function RootLayout() {
  const { status } = useSession();
  const signedIn = status === 'signedIn';
  useDeviceLanguage();

  useEffect(() => {
    void restoreSession();
  }, []);

  useEffect(() => {
    if (status !== 'restoring') void SplashScreen.hideAsync();
    // Nothing from a previous session (or hub) survives signing out.
    if (status === 'signedOut') queryClient.clear();
  }, [status]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={theme}>
            <StatusBar style="light" />
            {signedIn && <ServerEvents />}
            <OptionsHost />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Protected guard={signedIn}>
                <Stack.Screen name="(app)" />
              </Stack.Protected>
              <Stack.Protected guard={!signedIn}>
                <Stack.Screen name="connect" options={{ animation: 'fade' }} />
              </Stack.Protected>
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
