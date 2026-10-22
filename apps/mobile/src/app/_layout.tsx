import { QueryClientProvider } from '@tanstack/react-query';
import { useLocales } from 'expo-localization';
import {
  DarkTheme,
  DefaultTheme,
  type Href,
  router,
  Stack,
  type Theme,
  ThemeProvider,
  usePathname,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { Fragment, useEffect, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { OptionsHost } from '../components/ui/options-host';
import i18n, { storedPreference } from '../i18n';
import { resolveLanguage } from '../i18n/catalog';
import { useServerEvents } from '../lib/events';
import { queryClient } from '../lib/queries';
import { restoreSession, useSession } from '../lib/session';
import { colors, paletteOf, type Scheme, useScheme } from '../theme';

void SplashScreen.preventAutoHideAsync();

/** The navigation's colors, for each look. */
function navigationTheme(scheme: Scheme): Theme {
  const base = scheme === 'light' ? DefaultTheme : DarkTheme;
  const palette = paletteOf(scheme);
  return {
    ...base,
    dark: scheme === 'dark',
    colors: {
      ...base.colors,
      primary: palette.accentStrong,
      background: palette.background,
      card: palette.background,
      text: palette.text,
      border: palette.border,
      notification: palette.error,
    },
  };
}

/**
 * Styles are made once per look: a new look draws the app again from scratch, then goes back to
 * the screen the user was on.
 */
function useLook(): Scheme {
  const scheme = useScheme();
  const pathname = usePathname();
  const drawn = useRef(scheme);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route at the change only
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(paletteOf(scheme).background);
    if (drawn.current === scheme) return;
    drawn.current = scheme;
    const back = pathname;
    if (back && back !== '/') requestAnimationFrame(() => router.replace(back as Href));
  }, [scheme]);
  return scheme;
}

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
  const scheme = useLook();
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
          <ThemeProvider value={navigationTheme(scheme)}>
            <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
            {signedIn && <ServerEvents />}
            <Fragment key={scheme}>
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
            </Fragment>
          </ThemeProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
