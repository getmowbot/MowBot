import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTranslation } from 'react-i18next';
import { badgeText } from '../../../lib/board';
import { useNotifications } from '../../../lib/board-queries';
import { isAndroid } from '../../../lib/platform';
import { colors, currentScheme } from '../../../theme';

/**
 * System tab bar: Liquid Glass on iOS 26 (blur on older iOS), Material 3 navigation bar on
 * Android, with every color pinned so dynamic color never tints it: a white active pill with
 * black ink, yin/yang. Activity carries the unread notifications' count (kept live by events).
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const unread = badgeText(useNotifications().data?.unread ?? 0);
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
      blurEffect={
        currentScheme() === 'light' ? 'systemChromeMaterialLight' : 'systemChromeMaterialDark'
      }
      indicatorColor={colors.accentStrong}
      rippleColor={colors.ripple}
      badgeBackgroundColor={colors.error}
      badgeTextColor="#ffffff"
      labelVisibilityMode="labeled"
      minimizeBehavior="onScrollDown"
    >
      <NativeTabs.Trigger name="(home)" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="bots" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.bots')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.3', selected: 'person.3.fill' }}
          md="groups"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity" contentStyle={{ backgroundColor: colors.background }}>
        <NativeTabs.Trigger.Label>{t('tabs.activity')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
        <NativeTabs.Trigger.Badge hidden={!unread}>{unread}</NativeTabs.Trigger.Badge>
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
