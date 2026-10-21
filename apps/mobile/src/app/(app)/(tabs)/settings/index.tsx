import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  ArrowLeftRight,
  Bell,
  CalendarClock,
  Cpu,
  Gauge,
  Info,
  LogOut,
  MonitorSmartphone,
  Package,
  Plug,
  Radio,
  Server,
  Smartphone,
  UserRound,
  Vault,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Caption, StatusText } from '../../../../components/admin/parts';
import { ListCard } from '../../../../components/list-card';
import { Section, TabScroll } from '../../../../components/tab-scroll';
import { ChoiceRows, ICON_ROW_INSET, ListRow, ROW_INSET } from '../../../../components/ui/rows';
import {
  deviceLanguage,
  type LanguagePreference,
  setLanguagePreference,
  storedPreference,
} from '../../../../i18n';
import { resolveLanguage } from '../../../../i18n/catalog';
import { useDevices, useRoutines, useSystem, useUpdateMe } from '../../../../lib/admin-queries';
import { useLiveConnection } from '../../../../lib/events';
import { useMcpServers } from '../../../../lib/mcp-queries';
import { alertError, confirm } from '../../../../lib/options-menu';
import { urlLabel } from '../../../../lib/provider-form';
import { useMe, useProviders } from '../../../../lib/queries';
import { deviceName, signOut, useSession } from '../../../../lib/session';
import { useVault } from '../../../../lib/vault-queries';
import { colors } from '../../../../theme';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const session = useSession();
  const me = useMe();
  const live = useLiveConnection();
  const providers = useProviders();
  const routines = useRoutines();
  const system = useSystem();
  const devices = useDevices();
  const vault = useVault();
  const mcp = useMcpServers();
  const updateMe = useUpdateMe();
  const [language, setLanguage] = useState<LanguagePreference>(storedPreference);

  const chooseLanguage = (preference: LanguagePreference) => {
    setLanguage(preference);
    void setLanguagePreference(preference);
    // Bots answer in the account's language, as when it is changed on the web.
    const locale = resolveLanguage(preference, deviceLanguage());
    if (me.data && me.data.owner.locale !== locale) {
      updateMe.mutate(
        { locale },
        { onError: () => alertError(t('appAdmin.settings.languageNotSaved')) },
      );
    }
  };

  const leave = async (title: string, message: string, label: string) => {
    if (await confirm(title, message, { label, destructive: true })) await signOut();
  };

  const providerCount = providers.data?.length;
  const activeRoutines = routines.data?.filter((r) => r.enabled).length;
  const activeDevices = devices.data?.filter((d) => !d.revokedAt).length;
  const vaultCount = vault.data?.length;
  const mcpCount = mcp.data?.length;
  const phoneLanguage = t(`languages.${resolveLanguage('system', deviceLanguage())}`);

  return (
    <TabScroll
      onRefresh={() =>
        Promise.all([
          me.refetch(),
          providers.refetch(),
          routines.refetch(),
          system.refetch(),
          devices.refetch(),
          vault.refetch(),
          mcp.refetch(),
        ])
      }
    >
      <Section title={t('appAdmin.settings.hub')}>
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={Cpu}
            label={t('appAdmin.models.title')}
            value={
              providerCount === undefined
                ? undefined
                : providerCount === 0
                  ? t('appAdmin.settings.none')
                  : t('appAdmin.settings.providers', { count: providerCount })
            }
            onPress={() => router.push('/models')}
          />
          <ListRow
            icon={Vault}
            label={t('vault.title')}
            value={
              vaultCount === undefined
                ? undefined
                : vaultCount === 0
                  ? t('vault.empty')
                  : t('vault.count', { count: vaultCount })
            }
            onPress={() => router.push('/vault')}
          />
          <ListRow
            icon={Plug}
            label={t('mcp.title')}
            value={
              mcpCount === undefined
                ? undefined
                : mcpCount === 0
                  ? t('mcp.none')
                  : t('mcp.count', { count: mcpCount })
            }
            onPress={() => router.push('/mcp')}
          />
          <ListRow
            icon={CalendarClock}
            label={t('appAdmin.routines.title')}
            value={
              activeRoutines === undefined
                ? undefined
                : t('appAdmin.settings.routines', { count: activeRoutines })
            }
            onPress={() => router.push('/routines')}
          />
          <ListRow
            icon={Gauge}
            label={t('appAdmin.proactivity.title')}
            value={
              system.data
                ? system.data.paused
                  ? t('appAdmin.settings.paused')
                  : t('appAdmin.settings.active')
                : undefined
            }
            onPress={() => router.push('/proactivity')}
          />
          <ListRow
            icon={MonitorSmartphone}
            label={t('appAdmin.devices.title')}
            value={
              activeDevices === undefined
                ? undefined
                : t('appAdmin.settings.devices', { count: activeDevices })
            }
            onPress={() => router.push('/devices')}
          />
        </ListCard>
      </Section>

      <Section title={t('settings.account')}>
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={UserRound}
            label={t('settings.owner')}
            value={me.data?.owner.displayName ?? '…'}
            onPress={() => router.push('/account')}
          />
          <ListRow
            icon={Smartphone}
            label={t('settings.device')}
            value={me.data?.device.name ?? deviceName()}
          />
          <ListRow
            icon={Bell}
            label={t('push.title')}
            value={
              me.data ? (me.data.device.push.enabled ? t('push.on') : t('push.off')) : undefined
            }
            onPress={() => router.push('/notifications')}
          />
        </ListCard>
      </Section>

      <Section title={t('settings.language')}>
        <ListCard inset={ROW_INSET}>
          <ChoiceRows<LanguagePreference>
            options={[
              {
                value: 'system',
                label: t('settings.languageSystem'),
                hint: t('appAdmin.settings.languageAuto', { language: phoneLanguage }),
              },
              { value: 'fr', label: t('languages.fr') },
              { value: 'en', label: t('languages.en') },
            ]}
            value={language}
            onChange={chooseLanguage}
          />
        </ListCard>
        <Caption>{t('appAdmin.settings.languageBots')}</Caption>
      </Section>

      <Section title={t('settings.hub')}>
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={Server}
            label={t('settings.address')}
            value={session.hubUrl ? urlLabel(session.hubUrl) : '—'}
          />
          <ListRow
            icon={Radio}
            label={t('settings.connection')}
            accessory={
              <StatusText
                color={live ? colors.accentStrong : colors.textFaint}
                label={live ? t('settings.live') : t('settings.offline')}
              />
            }
          />
          <ListRow
            icon={ArrowLeftRight}
            label={t('settings.changeHub')}
            chevron={false}
            onPress={() =>
              void leave(
                t('settings.changeHub'),
                t('settings.changeHubConfirm'),
                t('settings.changeHub'),
              )
            }
          />
          <ListRow
            icon={LogOut}
            label={t('settings.logout')}
            destructive
            onPress={() =>
              void leave(
                t('settings.logoutConfirm'),
                t('settings.logoutHint'),
                t('settings.logout'),
              )
            }
          />
        </ListCard>
      </Section>

      <Section title={t('settings.about')}>
        <ListCard inset={ICON_ROW_INSET}>
          <ListRow
            icon={Info}
            label={t('settings.version')}
            value={Constants.expoConfig?.version ?? '—'}
          />
          <ListRow
            icon={Package}
            label={t('settings.expoSdk')}
            value={Constants.expoConfig?.sdkVersion ?? '—'}
          />
        </ListCard>
      </Section>
    </TabScroll>
  );
}
