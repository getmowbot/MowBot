import { Stack } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { RefreshControl, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme';

interface ScreenProps {
  /** Shown in the native header (with its back button). */
  title: string;
  children: ReactNode;
  /** Buttons at the right of the header (e.g. an options IconButton). */
  headerRight?: () => ReactNode;
  /** Pull to refresh. */
  onRefresh?: () => Promise<unknown>;
  /** false: the content handles its own scrolling (lists, a full-screen view). */
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}

/**
 * A screen pushed over the tabs (settings, a team, a PC…): native header with the system back
 * button (Liquid Glass on iOS 26), then content that scrolls above the keyboard.
 */
export function Screen({
  title,
  children,
  headerRight,
  onRefresh,
  scroll = true,
  contentStyle,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (!onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const header = <Stack.Screen options={{ headerShown: true, title, headerRight }} />;
  if (!scroll) {
    return (
      <View style={styles.root}>
        {header}
        {children}
      </View>
    );
  }
  return (
    <>
      {header}
      <KeyboardAwareScrollView
        style={styles.root}
        bottomOffset={24}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.xxl },
          contentStyle,
        ]}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void refresh()}
              tintColor={colors.textMuted}
              colors={[colors.accentInk]}
              progressBackgroundColor={colors.accentStrong}
            />
          ) : undefined
        }
      >
        {children}
      </KeyboardAwareScrollView>
    </>
  );
}

/** Buttons at the bottom of a form, full width and stacked. */
export function FormActions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.xl },
  actions: { gap: spacing.md },
});
