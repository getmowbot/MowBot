import { type ReactNode, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme';
import { T } from './ui/text';

interface Props {
  children: ReactNode;
  /** Pull to refresh (the event stream usually makes it unnecessary). */
  onRefresh?: () => Promise<unknown>;
}

/** Scrolling content of a tab, inset under the native header and above the tab bar. */
export function TabScroll({ children, onRefresh }: Props) {
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
  return (
    <ScrollView
      style={styles.root}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
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
    </ScrollView>
  );
}

/** A titled group of content. */
export function Section({
  title,
  accessory,
  children,
}: {
  title: string;
  accessory?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <T variant="overline" tone="faint" style={styles.sectionTitle} numberOfLines={1}>
          {title}
        </T>
        {accessory}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xl },
  section: { gap: spacing.sm },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  sectionTitle: { flex: 1 },
});
