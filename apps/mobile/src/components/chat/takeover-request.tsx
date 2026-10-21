import { router } from 'expo-router';
import { Hand, Monitor, Undo2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import type { TakeoverRequestPart } from '../../lib/activity';
import { alertError } from '../../lib/options-menu';
import { useComputer, useComputerAction } from '../../lib/pc-queries';
import { useMe } from '../../lib/queries';
import { colors } from '../../theme';
import { Pill } from '../board/pill';
import { Surface } from '../ui/surface';
import { T } from '../ui/text';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * A bot needs the user at the keyboard of its PC (a sign-in, a captcha): one button opens the
 * PC and takes control. Giving control back wakes the bot up; the card then shrinks to a line.
 */
export function TakeoverRequest({ part, botName }: { part: TakeoverRequestPart; botName: string }) {
  const { t } = useTranslation();
  const pc = useComputer(part.computerId).data;
  const action = useComputerAction(part.computerId);
  const me = useMe();
  const control = pc?.control ?? null;
  const inControl = Boolean(control && me.data && control.deviceId === me.data.device.id);

  if (part.status === 'returned') {
    return (
      <View style={styles.answered}>
        <Hand size={16} color={colors.textFaint} />
        <T variant="footnote" tone="muted" numberOfLines={1} style={styles.shrink}>
          {t('takeoverCard.returned')} · {part.reason}
        </T>
      </View>
    );
  }

  const openPc = (takeOver: boolean) =>
    router.push(`/pc/${part.computerId}${takeOver ? '?takeover=1' : ''}`);
  return (
    <Surface style={styles.card}>
      <View style={styles.head}>
        <View style={styles.icon}>
          <Hand size={18} color={colors.text} />
        </View>
        <View style={styles.headText}>
          <T variant="headline" numberOfLines={2}>
            {t('takeoverCard.title', { name: botName })}
          </T>
          {part.url ? (
            <T variant="caption" tone="faint" numberOfLines={1}>
              {hostOf(part.url)}
            </T>
          ) : null}
        </View>
      </View>
      <T variant="callout" tone="muted" selectable>
        {part.reason}
      </T>
      {control ? (
        <T variant="caption" tone="faint">
          {inControl
            ? t('takeoverCard.inControl', { name: botName })
            : t('takeoverCard.otherDevice')}
        </T>
      ) : null}
      <View style={styles.actions}>
        {inControl ? (
          <>
            <Pill
              variant="solid"
              icon={Undo2}
              label={t('takeoverCard.release')}
              loading={action.isPending}
              onPress={() =>
                action.mutate('release', { onError: () => alertError(t('common.actionFailed')) })
              }
            />
            <Pill
              icon={Monitor}
              label={t('takeoverCard.showScreen')}
              onPress={() => openPc(false)}
            />
          </>
        ) : (
          <Pill
            variant="solid"
            icon={Hand}
            label={t('takeoverCard.take')}
            onPress={() => openPc(true)}
          />
        )}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  answered: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
  },
  shrink: { flexShrink: 1 },
});
