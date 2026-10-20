import type { Device, DeviceKind } from '@mowbot/contract';
import { Laptop, type LucideIcon, Monitor, Smartphone, Terminal } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';
import { Caption, LoadError, Loading, Note } from '../../components/admin/parts';
import { ListCard } from '../../components/list-card';
import { Screen } from '../../components/screen';
import { Section } from '../../components/tab-scroll';
import { ICON_ROW_INSET, ListRow } from '../../components/ui/rows';
import { T } from '../../components/ui/text';
import { adminError, useDevices, useRevokeDevice } from '../../lib/admin-queries';
import { alertError, confirm } from '../../lib/options-menu';
import { dateTimeText } from '../../lib/routine-form';
import { signOut } from '../../lib/session';
import { timeAgo } from '../../lib/time';
import { colors } from '../../theme';

const KIND_ICONS: Record<DeviceKind, LucideIcon> = {
  web: Monitor,
  ios: Smartphone,
  android: Smartphone,
  desktop: Laptop,
  cli: Terminal,
};

function DeviceRow({
  device,
  revoking,
  onRevoke,
}: {
  device: Device;
  revoking: boolean;
  onRevoke(device: Device): void;
}) {
  const { t, i18n } = useTranslation();
  const hint = t('appAdmin.devices.seen', {
    kind: t(`appAdmin.devices.kinds.${device.kind}`),
    created: dateTimeText(device.createdAt, i18n.language),
    seen: device.lastSeenAt
      ? timeAgo(device.lastSeenAt, t, i18n.language)
      : t('appAdmin.devices.never'),
  });

  // This phone signs out (which revokes it); the web keeps it out of reach the same way.
  const signOutHere = async () => {
    if (
      await confirm(t('settings.logoutConfirm'), t('settings.logoutHint'), {
        label: t('settings.logout'),
        destructive: true,
      })
    ) {
      await signOut();
    }
  };

  const accessory = revoking ? (
    <ActivityIndicator size="small" color={colors.textMuted} />
  ) : device.current ? (
    <T variant="callout" tone="muted">
      {t('appAdmin.devices.current')}
    </T>
  ) : device.revokedAt ? (
    <T variant="callout" tone="faint">
      {t('appAdmin.devices.revoked')}
    </T>
  ) : (
    <T variant="callout" tone="danger">
      {t('appAdmin.devices.revoke')}
    </T>
  );

  return (
    <ListRow
      icon={KIND_ICONS[device.kind]}
      label={device.name}
      hint={hint}
      accessory={accessory}
      chevron={false}
      disabled={revoking}
      onPress={
        device.current
          ? () => void signOutHere()
          : device.revokedAt
            ? undefined
            : () => onRevoke(device)
      }
    />
  );
}

/** Every signed-in browser and app, each with its own session that can be revoked. */
export default function DevicesScreen() {
  const { t } = useTranslation();
  const devices = useDevices();
  const revoke = useRevokeDevice();
  const list = devices.data ?? [];
  // This device first, then the most recently seen.
  const active = list
    .filter((d) => !d.revokedAt)
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (b.lastSeenAt ?? b.createdAt).localeCompare(a.lastSeenAt ?? a.createdAt),
    );
  const revoked = list.filter((d) => d.revokedAt);

  const askRevoke = async (device: Device) => {
    const ok = await confirm(
      t('appAdmin.devices.confirmRevoke', { name: device.name }),
      t('appAdmin.devices.revokeHint'),
      { label: t('appAdmin.devices.revoke'), destructive: true },
    );
    if (!ok) return;
    revoke.mutate(device.id, {
      onError: (err) => alertError(adminError(err, t('common.actionFailed'))),
    });
  };

  const row = (device: Device) => (
    <DeviceRow
      key={device.id}
      device={device}
      revoking={revoke.isPending && revoke.variables === device.id}
      onRevoke={(d) => void askRevoke(d)}
    />
  );

  return (
    <Screen title={t('appAdmin.devices.title')} onRefresh={() => devices.refetch()}>
      <Note>{t('appAdmin.devices.subtitle')}</Note>
      {devices.isPending ? (
        <Loading />
      ) : devices.isError ? (
        <LoadError
          message={t('appAdmin.devices.loadFailed')}
          onRetry={() => void devices.refetch()}
        />
      ) : (
        <>
          <Section title={t('appAdmin.devices.signedIn')}>
            <ListCard inset={ICON_ROW_INSET}>{active.map(row)}</ListCard>
            <Caption>{t('appAdmin.devices.currentHint')}</Caption>
          </Section>
          {revoked.length > 0 && (
            <Section title={t('appAdmin.devices.revokedSection')}>
              <ListCard inset={ICON_ROW_INSET}>{revoked.map(row)}</ListCard>
            </Section>
          )}
        </>
      )}
    </Screen>
  );
}
