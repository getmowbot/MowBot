import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { colors } from '../../theme';
import { Button } from '../ui/button';
import { T } from '../ui/text';

/** What a form could not do, under the form. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <T variant="footnote" tone="danger" accessibilityLiveRegion="polite" style={styles.indent}>
      {message}
    </T>
  );
}

/** A short explanation above or under a group, aligned with the rows' text. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <T variant="footnote" tone="muted" style={styles.indent}>
      {children}
    </T>
  );
}

/** A caption under a group (time zone, a field's rule…). */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <T variant="caption" tone="faint" style={styles.indent}>
      {children}
    </T>
  );
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.textMuted} />
    </View>
  );
}

/** A list that could not load, with a way to try again. */
export function LoadError({ message, onRetry }: { message?: string; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.error}>
      <T variant="callout" tone="muted" style={styles.centered}>
        {message ?? t('errors.generic')}
      </T>
      <Button label={t('common.retry')} variant="secondary" onPress={onRetry} />
    </View>
  );
}

/** A small round status light (live, on, off). */
export function Dot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

/** A dot and a word, on the right of a row. */
export function StatusText({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.status}>
      <Dot color={color} />
      <T variant="callout" tone="muted" numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  indent: { paddingHorizontal: 4 },
  loading: { paddingVertical: 48, alignItems: 'center' },
  error: { paddingVertical: 32, gap: 16 },
  centered: { textAlign: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
});
