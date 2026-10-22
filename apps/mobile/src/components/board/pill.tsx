import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, type StyleProp, StyleSheet, type ViewStyle } from 'react-native';
import { isAndroid } from '../../lib/platform';
import { colors, themed } from '../../theme';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

interface Props {
  label: string;
  onPress(): void;
  icon?: LucideIcon;
  /** `solid`: white with black ink (the key action); `outline`; `ghost`: text only. */
  variant?: 'solid' | 'outline' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export const PILL_HEIGHT = isAndroid ? 36 : 34;

/** A compact rounded button for cards (answers, pause, "read all"): one height everywhere. */
export function Pill({
  label,
  onPress,
  icon: Icon,
  variant = 'outline',
  loading = false,
  disabled = false,
  accessibilityLabel,
  style,
}: Props) {
  const solid = variant === 'solid';
  const ink = solid ? colors.accentInk : variant === 'ghost' ? colors.textMuted : colors.text;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      onAccent={solid}
      hitSlop={4}
      style={[
        styles.pill,
        solid && styles.solid,
        variant === 'outline' && styles.outline,
        variant === 'ghost' && styles.ghost,
        disabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={ink} />
      ) : (
        <>
          {Icon ? <Icon size={15} color={ink} strokeWidth={2.2} /> : null}
          <T variant="footnote" numberOfLines={2} style={[styles.label, { color: ink }]}>
            {label}
          </T>
        </>
      )}
    </Touchable>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    pill: {
      minHeight: PILL_HEIGHT,
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 9999,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      overflow: 'hidden',
    },
    solid: { backgroundColor: colors.accentStrong },
    outline: { borderWidth: 1, borderColor: colors.borderStrong },
    ghost: { paddingHorizontal: 10 },
    disabled: { opacity: 0.45 },
    label: { fontWeight: '600', flexShrink: 1 },
  }),
);
