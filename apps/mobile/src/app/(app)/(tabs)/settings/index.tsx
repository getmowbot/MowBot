import Constants from 'expo-constants';
import { LogOut, Server } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';
import { ListCard } from '../../../../components/list-card';
import { Section, TabScroll } from '../../../../components/tab-scroll';
import { Button } from '../../../../components/ui/button';
import { Segmented } from '../../../../components/ui/segmented';
import { T } from '../../../../components/ui/text';
import { Touchable } from '../../../../components/ui/touchable';
import { type LanguagePreference, setLanguagePreference, storedPreference } from '../../../../i18n';
import { useLiveConnection } from '../../../../lib/events';
import { useMe } from '../../../../lib/queries';
import { deviceName, signOut, useSession } from '../../../../lib/session';
import { colors, fonts } from '../../../../theme';

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <T variant="callout" tone="muted">
        {label}
      </T>
      <T variant="callout" numberOfLines={1} selectable style={[styles.value, mono && styles.mono]}>
        {value}
      </T>
    </View>
  );
}

export default function SettingsScreen() {
  const { t } = useTranslation();
  const session = useSession();
  const me = useMe();
  const live = useLiveConnection();
  const [language, setLanguage] = useState<LanguagePreference>(storedPreference);

  const chooseLanguage = (preference: LanguagePreference) => {
    setLanguage(preference);
    void setLanguagePreference(preference);
  };

  const confirmSignOut = (title: string, message: string) =>
    Alert.alert(title, message, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.logout'), style: 'destructive', onPress: () => void signOut() },
    ]);

  return (
    <TabScroll>
      <Section title={t('settings.language')}>
        <Segmented<LanguagePreference>
          label={t('settings.language')}
          options={[
            { value: 'system', label: t('settings.languageSystem') },
            { value: 'fr', label: t('languages.fr') },
            { value: 'en', label: t('languages.en') },
          ]}
          value={language}
          onChange={chooseLanguage}
        />
        {language === 'system' && (
          <T variant="caption" tone="faint" style={styles.indent}>
            {t('settings.languageSystemHint')}
          </T>
        )}
      </Section>

      <Section title={t('settings.hub')}>
        <ListCard inset={16}>
          <InfoRow label={t('settings.address')} value={session.hubUrl ?? '—'} mono />
          <View style={styles.row}>
            <T variant="callout" tone="muted">
              {t('settings.connection')}
            </T>
            <View style={styles.status}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: live ? colors.accentStrong : colors.textFaint },
                ]}
              />
              <T variant="callout">{live ? t('settings.live') : t('settings.offline')}</T>
            </View>
          </View>
          <Touchable
            accessibilityRole="button"
            onPress={() => confirmSignOut(t('settings.changeHub'), t('settings.changeHubConfirm'))}
            style={styles.row}
          >
            <Server size={16} color={colors.text} />
            <T variant="callout" style={styles.action}>
              {t('settings.changeHub')}
            </T>
          </Touchable>
        </ListCard>
      </Section>

      <Section title={t('settings.account')}>
        <ListCard inset={16}>
          <InfoRow label={t('settings.owner')} value={me.data?.owner.displayName ?? '…'} />
          <InfoRow label={t('settings.device')} value={me.data?.device.name ?? deviceName()} />
        </ListCard>
        <Button
          label={t('settings.logout')}
          variant="danger"
          icon={LogOut}
          onPress={() => confirmSignOut(t('settings.logoutConfirm'), t('settings.logoutHint'))}
        />
      </Section>

      <Section title={t('settings.about')}>
        <ListCard inset={16}>
          <InfoRow label={t('settings.version')} value={Constants.expoConfig?.version ?? '—'} />
          <InfoRow label={t('settings.expoSdk')} value={Constants.expoConfig?.sdkVersion ?? '—'} />
        </ListCard>
      </Section>
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  indent: { paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  value: { flex: 1, textAlign: 'right' },
  mono: { fontFamily: fonts.mono, fontSize: 13.5 },
  status: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  action: { flex: 1 },
});
