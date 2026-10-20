import type { Computer } from '@mowbot/contract';
import { CircleAlert, Hand, MonitorSmartphone, Play, PowerOff } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { DEFAULT_ASPECT } from '../../lib/desktop';
import { colors, fonts, spacing } from '../../theme';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';

const STATUS_COLORS: Record<Computer['status'], string> = {
  running: colors.accentStrong,
  starting: colors.warning,
  stopping: colors.warning,
  stopped: colors.textFaint,
  error: colors.danger,
};

/** "● On · Bob, Alice": the PC's state and who works on it. */
export function StatusLine({ computer, botNames }: { computer: Computer; botNames: string[] }) {
  const { t } = useTranslation();
  const who = botNames.length > 0 ? botNames.join(', ') : t('pcView.noBots');
  return (
    <View style={styles.statusLine}>
      <View style={[styles.dot, { backgroundColor: STATUS_COLORS[computer.status] }]} />
      <T variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
        {`${t(`pcView.status.${computer.status}`)} · ${who}`}
      </T>
    </View>
  );
}

/** Who has the mouse and keyboard, when it is not the bots. */
export function ControlBanner({ mine }: { mine: boolean }) {
  const { t } = useTranslation();
  const Icon = mine ? Hand : MonitorSmartphone;
  return (
    <Surface style={styles.banner} accessibilityRole="alert">
      <Icon size={18} color={colors.text} />
      <T variant="footnote" style={styles.shrink}>
        {t(mine ? 'pcView.inControl' : 'pcView.otherDevice')}
      </T>
    </Surface>
  );
}

/** In place of the screen while the PC is not running, with what can be done about it. */
export function PcStateCard({
  computer,
  onTurnOn,
  turningOn,
}: {
  computer: Computer;
  onTurnOn(): void;
  turningOn: boolean;
}) {
  const { t } = useTranslation();
  const { status } = computer;
  const transition = status === 'starting' || status === 'stopping';
  return (
    <Surface style={styles.card}>
      {transition ? (
        <>
          <ActivityIndicator color={colors.textMuted} />
          <T variant="headline" style={styles.center}>
            {t(status === 'starting' ? 'pcView.starting' : 'pcView.stopping')}
          </T>
          {status === 'starting' && (
            <T variant="footnote" tone="muted" style={styles.center}>
              {t('pcView.startingHint')}
            </T>
          )}
        </>
      ) : (
        <>
          {status === 'error' ? (
            <CircleAlert size={28} color={colors.danger} strokeWidth={1.75} />
          ) : (
            <PowerOff size={28} color={colors.textFaint} strokeWidth={1.75} />
          )}
          <T
            variant="headline"
            tone={status === 'error' ? 'danger' : 'default'}
            style={styles.center}
          >
            {t(status === 'error' ? 'pcView.failed' : 'pcView.off')}
          </T>
          {status === 'error' ? (
            computer.statusDetail ? (
              <T variant="caption" tone="muted" numberOfLines={6} style={styles.detail}>
                {computer.statusDetail}
              </T>
            ) : null
          ) : (
            <T variant="footnote" tone="muted" style={styles.center}>
              {t('pcView.offHint')}
            </T>
          )}
          <Button
            label={t('pcView.turnOn')}
            icon={Play}
            onPress={onTurnOn}
            loading={turningOn}
            style={styles.action}
          />
        </>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 20 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  shrink: { flexShrink: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  card: {
    width: '100%',
    // About a screen's shape on a phone, taller when the text needs it.
    minHeight: 360 / DEFAULT_ASPECT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  center: { textAlign: 'center' },
  detail: { fontFamily: fonts.mono, textAlign: 'center' },
  action: { marginTop: spacing.sm, alignSelf: 'stretch' },
});
