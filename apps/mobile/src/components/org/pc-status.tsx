import type { Computer } from '@mowbot/contract';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { colors } from '../../theme';
import { T } from '../ui/text';

const DOTS: Record<Computer['status'], string> = {
  running: colors.accentStrong,
  starting: colors.warning,
  stopping: colors.warning,
  stopped: colors.textFaint,
  error: colors.danger,
};

/** A PC's state as a dot and a word ("PC on", "PC asleep"…), with something after it. */
export function PcStatus({
  computer,
  suffix,
}: {
  computer: Computer | undefined;
  suffix?: string;
}) {
  const { t } = useTranslation();
  if (!computer && !suffix) return null;
  return (
    <View style={styles.row}>
      {computer ? <View style={[styles.dot, { backgroundColor: DOTS[computer.status] }]} /> : null}
      <T variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        {[computer ? t(`org.pc.${computer.status}`) : null, suffix].filter(Boolean).join(' · ')}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  shrink: { flexShrink: 1 },
});
