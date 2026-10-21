import type { PushPrefs } from '@mowbot/contract';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';
import { Caption, LoadError, Loading, Note } from '../../components/admin/parts';
import { ListCard } from '../../components/list-card';
import { Screen } from '../../components/screen';
import { Section } from '../../components/tab-scroll';
import { ListRow, ROW_INSET, SwitchRow } from '../../components/ui/rows';
import { adminError, useUpdatePushPrefs } from '../../lib/admin-queries';
import { alertError } from '../../lib/options-menu';
import { pushAvailability, usePushPermission, useSetPushEnabled } from '../../lib/push';
import { pushIsBlocked, pushIsOn } from '../../lib/push-rules';
import { useMe } from '../../lib/queries';
import { spacing } from '../../theme';

function PrefSwitch({
  pref,
  prefs,
  label,
  hint,
  disabled,
}: {
  pref: keyof PushPrefs;
  prefs: PushPrefs;
  label: string;
  hint?: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const update = useUpdatePushPrefs();
  const value = update.isPending ? (update.variables[pref] ?? prefs[pref]) : prefs[pref];

  const change = (next: boolean) => {
    const patch: Partial<PushPrefs> = {};
    patch[pref] = next;
    update.mutate(patch, {
      onError: (err) => alertError(adminError(err, t('push.notSaved'))),
    });
  };

  return (
    <SwitchRow label={label} hint={hint} value={value} onChange={change} disabled={disabled} />
  );
}

/** This phone's notifications: on or off, what it hears about, and whether bots' words show. */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const me = useMe();
  const permission = usePushPermission();
  const toggle = useSetPushEnabled();
  const available = pushAvailability === 'available';
  const blocked = available && pushIsBlocked(permission.data);
  const push = me.data?.device.push;
  const on = available && push !== undefined && pushIsOn(push.enabled, permission.data);
  const shown = toggle.isPending ? toggle.variables : on;

  const change = (next: boolean) => {
    // The system prompt may be up: one change at a time.
    if (toggle.isPending) return;
    toggle.mutate(next, {
      onError: (err) => alertError(adminError(err, t('push.notSaved'))),
    });
  };

  const reason =
    pushAvailability !== 'available'
      ? t(`push.unavailable.${pushAvailability}`)
      : blocked
        ? t('push.blocked')
        : null;

  return (
    <Screen
      title={t('push.title')}
      onRefresh={() => Promise.all([me.refetch(), available ? permission.refetch() : null])}
    >
      <Note>{t('push.subtitle')}</Note>
      {me.isPending ? (
        <Loading />
      ) : me.isError ? (
        <LoadError onRetry={() => void me.refetch()} />
      ) : (
        <>
          <View style={styles.group}>
            <ListCard inset={ROW_INSET}>
              <SwitchRow
                label={t('push.master')}
                value={shown}
                onChange={change}
                disabled={!available || blocked || permission.isPending}
              />
              {blocked && (
                <ListRow
                  label={t('push.openSettings')}
                  onPress={() => void Linking.openSettings()}
                />
              )}
            </ListCard>
            {reason && <Caption>{reason}</Caption>}
          </View>

          <Section title={t('push.what')}>
            <ListCard inset={ROW_INSET}>
              <PrefSwitch
                pref="finished"
                prefs={me.data.device.push.prefs}
                label={t('push.finished')}
                disabled={!shown}
              />
              <PrefSwitch
                pref="needsYou"
                prefs={me.data.device.push.prefs}
                label={t('push.needsYou')}
                hint={t('push.needsYouHint')}
                disabled={!shown}
              />
              <PrefSwitch
                pref="notifications"
                prefs={me.data.device.push.prefs}
                label={t('push.notifications')}
                hint={t('push.notificationsHint')}
                disabled={!shown}
              />
            </ListCard>
          </Section>

          <Section title={t('push.privacy')}>
            <ListCard inset={ROW_INSET}>
              <PrefSwitch
                pref="hideContent"
                prefs={me.data.device.push.prefs}
                label={t('push.hideContent')}
                hint={t('push.hideContentHint')}
                disabled={!shown}
              />
            </ListCard>
          </Section>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
