import type { VaultAction, VaultKind } from '@mowbot/contract';
import { router } from 'expo-router';
import {
  Ban,
  Cookie,
  KeyRound,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  MonitorDown,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldQuestionMark,
  UserRoundX,
} from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { openOptions } from '../../lib/options-menu';
import { colors, themed } from '../../theme';
import { T } from '../ui/text';

export const KIND_ICONS: Record<VaultKind, LucideIcon> = {
  session: Cookie,
  login: KeyRound,
  secret: LockKeyhole,
};

export const ACTION_ICONS: Record<VaultAction, LucideIcon> = {
  created: Plus,
  updated: Pencil,
  captured: MonitorDown,
  used: LogIn,
  requested: ShieldQuestionMark,
  granted: ShieldCheck,
  denied: Ban,
  revoked: UserRoundX,
};

/** Vault values are typed once, never prefilled: no autofill, no suggestions, no capitals. */
export const SECRET_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  textContentType: 'none',
  importantForAutofill: 'no',
} as const;

/** "Asks first": the entry needs the user's approval for each new bot. */
export function AskBadge() {
  const { t } = useTranslation();
  return (
    <View style={styles.badge}>
      <ShieldQuestionMark size={13} color={colors.textMuted} strokeWidth={2.2} />
      <T variant="caption" tone="muted" numberOfLines={1}>
        {t('vault.ask')}
      </T>
    </View>
  );
}

/** Login, secret, or a session from a PC: the vault's "+". */
export function useVaultAddMenu(): () => void {
  const { t } = useTranslation();
  return () =>
    openOptions({
      title: t('vault.add'),
      options: [
        {
          label: t('vault.addLogin'),
          icon: KeyRound,
          onPress: () => router.push('/vault/new?kind=login'),
        },
        {
          label: t('vault.addSecret'),
          icon: LockKeyhole,
          onPress: () => router.push('/vault/new?kind=secret'),
        },
        {
          label: t('vault.addSession'),
          icon: MonitorDown,
          onPress: () => router.push('/vault/session'),
        },
      ],
    });
}

const styles = themed(() =>
  StyleSheet.create({
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 9999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderStrong,
      flexShrink: 0,
    },
  }),
);
