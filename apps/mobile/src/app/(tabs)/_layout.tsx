import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { isAndroid } from '../../lib/platform';
import { colors } from '../../theme';

/**
 * System tab bar: Liquid Glass on iOS 26 (blur on older iOS), Material 3 navigation bar on
 * Android, with every color pinned so dynamic color never tints it: a white active pill with
 * black ink, yin/yang.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  return (
    <NativeTabs
      tintColor={colors.accentStrong}
      iconColor={{
        default: colors.textMuted,
        selected: isAndroid ? colors.accentInk : colors.accentStrong,
      }}
      labelStyle={{
        default: { color: colors.textMuted },
        selected: { color: colors.text },
      }}
      backgroundColor={isAndroid ? colors.surfaceContainer : undefined}
      blurEffect="systemChromeMaterialDark"
      indicatorColor={colors.accentStrong}
      rippleColor={colors.ripple}
      badgeBackgroundColor={colors.error}
      badgeTextColor={colors.accentStrong}
      labelVisibilityMode="labeled"
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="(home)" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.bubble.right',
            selected: 'bubble.left.and.bubble.right.fill',
          }}
          md="forum"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.activity')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="org" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.org')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.3', selected: 'person.3.fill' }}
          md="groups"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md="settings"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
