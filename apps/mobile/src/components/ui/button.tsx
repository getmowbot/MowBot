import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { isAndroid } from '../../lib/platform';
import { colors } from '../../theme';
import { Surface } from './surface';
import { T } from './text';
import { Touchable } from './touchable';

type Variant = 'primary' | 'secondary' | 'danger';

interface ButtonProps {
  label: string;
  onPress(): void;
  variant?: Variant;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Yin/yang: the key action is white with black ink; the others are outlined. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  icon: Icon,
  loading = false,
  disabled = false,
  style,
}: ButtonProps) {
  const primary = variant === 'primary';
  const ink = primary ? colors.accentInk : variant === 'danger' ? colors.danger : colors.text;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      onAccent={primary}
      style={[
        styles.button,
        primary ? styles.primary : styles.outline,
        variant === 'danger' && styles.danger,
        (disabled || loading) && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={ink} />
      ) : (
        <>
          {Icon && <Icon size={18} color={ink} strokeWidth={2} />}
          <T variant="headline" style={{ color: ink }}>
            {label}
          </T>
        </>
      )}
    </Touchable>
  );
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onPress(): void;
  /** Float on Liquid Glass (iOS 26) / a tonal circle (Android) instead of bare. */
  raised?: boolean;
  size?: number;
  color?: string;
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  raised = false,
  size = 40,
  color = colors.text,
}: IconButtonProps) {
  const glyph = <Icon size={Math.round(size * 0.5)} color={color} strokeWidth={2} />;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      borderless={isAndroid && !raised}
      hitSlop={6}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    >
      {raised ? (
        <Surface variant="bar" radius={size / 2} interactive style={styles.center}>
          {glyph}
        </Surface>
      ) : (
        <View style={styles.center}>{glyph}</View>
      )}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: isAndroid ? 48 : 50,
    paddingHorizontal: 22,
    borderRadius: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  primary: { backgroundColor: colors.accentStrong },
  outline: { borderWidth: 1, borderColor: colors.borderStrong },
  danger: { borderColor: 'rgba(255, 107, 133, 0.35)' },
  disabled: { opacity: 0.45 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
