import { WifiOff } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotAvatar } from '../components/bot-avatar';
import { reveal } from '../components/reveal';
import { Button } from '../components/ui/button';
import { Field } from '../components/ui/field';
import { Surface } from '../components/ui/surface';
import { T } from '../components/ui/text';
import { DEFAULT_HUB_URL } from '../lib/hub-url';
import {
  restoreSession,
  type SignInError,
  SignInFailure,
  signIn,
  useSession,
} from '../lib/session';
import { colors, themed } from '../theme';

/** Three characters greet the user (fixed seeds: always the same faces). */
function Welcome() {
  return (
    <View style={styles.welcome}>
      <BotAvatar seed="echo" size={56} />
      <BotAvatar seed="chef" size={80} />
      <BotAvatar seed="milo" size={56} />
    </View>
  );
}

/** Pick a hub on the LAN and sign in with the owner's password. */
export default function ConnectScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [hub, setHub] = useState(session.hubUrl ?? DEFAULT_HUB_URL);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const explain = (reason: SignInError): string => {
    switch (reason) {
      case 'invalidUrl':
        return t('connect.invalidUrl');
      case 'unreachable':
        return `${t('connect.unreachable', { url: hub.trim() })} ${t('connect.unreachableHint')}`;
      case 'setupRequired':
        return t('connect.setupRequired');
      case 'invalid_credentials':
      case 'rate_limited':
      case 'validation_failed':
        return t(`errors.${reason}`);
      default:
        return t('errors.generic');
    }
  };

  const submit = async () => {
    if (!password || busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(hub, password);
    } catch (failure) {
      setError(failure instanceof SignInFailure ? explain(failure.reason) : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    await restoreSession();
    setRetrying(false);
  };

  return (
    <KeyboardAwareScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 },
      ]}
      bottomOffset={24}
      keyboardShouldPersistTaps="handled"
    >
      <Animated.View entering={reveal(0)}>
        <Welcome />
      </Animated.View>
      <Animated.View entering={reveal(1)} style={styles.heading}>
        <T variant="largeTitle">{t('common.appName')}</T>
        <T tone="muted" style={styles.centerText}>
          {t('connect.subtitle')}
        </T>
      </Animated.View>

      {session.status === 'unreachable' && session.hubUrl && (
        <Surface style={styles.card}>
          <View style={styles.cardTitle}>
            <WifiOff size={16} color={colors.text} />
            <T variant="headline">{t('connect.unreachableTitle')}</T>
          </View>
          <T variant="footnote" tone="muted">
            {t('connect.unreachable', { url: session.hubUrl })} {t('connect.unreachableHint')}
          </T>
          <Button
            label={t('common.retry')}
            variant="secondary"
            loading={retrying}
            onPress={() => void retry()}
          />
        </Surface>
      )}
      {session.notice === 'sessionExpired' && (
        <T variant="footnote" tone="muted" style={styles.centerText}>
          {t('connect.sessionExpired')}
        </T>
      )}

      <Animated.View entering={reveal(2)} style={styles.form}>
        <Field
          label={t('connect.hubLabel')}
          hint={t('connect.hubHint')}
          value={hub}
          onChangeText={setHub}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="URL"
          returnKeyType="next"
        />
        <Field
          label={t('connect.passwordLabel')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
        />
        {error && (
          <T variant="footnote" tone="danger" accessibilityLiveRegion="polite">
            {error}
          </T>
        )}
        <Button
          label={busy ? t('connect.submitting') : t('connect.submit')}
          loading={busy}
          disabled={!password}
          onPress={() => void submit()}
        />
      </Animated.View>
    </KeyboardAwareScrollView>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 24 },
    welcome: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 4 },
    heading: { alignItems: 'center', gap: 6 },
    centerText: { textAlign: 'center' },
    card: { padding: 16, gap: 10 },
    cardTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    form: { gap: 16 },
  }),
);
