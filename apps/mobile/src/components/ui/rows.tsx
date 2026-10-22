import { Check, ChevronRight, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { isAndroid, isIOS } from '../../lib/platform';
import { colors } from '../../theme';
import { T } from './text';
import { Touchable } from './touchable';

/**
 * Rows of a ListCard (settings, menus): one height, one padding and one icon size everywhere,
 * so labels, values and chevrons line up from one screen to the next.
 */
export const ROW_INSET = 16;
/** ListCard divider inset for rows with an icon (past the icon). */
export const ICON_ROW_INSET = ROW_INSET + 20 + 14;

interface ListRowProps {
  label: string;
  icon?: LucideIcon;
  /** Drawn instead of `icon` (a provider's mark…), 20 points wide. */
  leading?: ReactNode;
  /** Secondary text on the right (current value). */
  value?: string;
  /** Second line under the label. */
  hint?: string;
  onPress?(): void;
  destructive?: boolean;
  /** Something else on the right (a badge, a spinner) instead of the value. */
  accessory?: ReactNode;
  /** Defaults to a chevron when the row opens something. */
  chevron?: boolean;
  disabled?: boolean;
}

export function ListRow({
  label,
  icon: Icon,
  leading,
  value,
  hint,
  onPress,
  destructive = false,
  accessory,
  chevron = Boolean(onPress) && !destructive,
  disabled = false,
}: ListRowProps) {
  const ink = destructive ? colors.danger : colors.text;
  const content = (
    <>
      {leading ??
        (Icon ? <Icon size={20} color={destructive ? colors.danger : colors.textMuted} /> : null)}
      <View style={styles.text}>
        <T variant="body" numberOfLines={1} style={{ color: ink }}>
          {label}
        </T>
        {hint ? (
          <T variant="footnote" tone="muted" numberOfLines={3}>
            {hint}
          </T>
        ) : null}
      </View>
      {accessory ??
        (value ? (
          <T variant="callout" tone="muted" numberOfLines={1} style={styles.value}>
            {value}
          </T>
        ) : null)}
      {chevron ? <ChevronRight size={18} color={colors.textFaint} /> : null}
    </>
  );
  if (!onPress) return <View style={[styles.row, disabled && styles.disabled]}>{content}</View>;
  return (
    <Touchable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[styles.row, disabled && styles.disabled]}
    >
      {content}
    </Touchable>
  );
}

interface SwitchRowProps {
  label: string;
  hint?: string;
  value: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
}

export function SwitchRow({ label, hint, value, onChange, disabled = false }: SwitchRowProps) {
  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <View style={styles.text}>
        <T variant="body" numberOfLines={2}>
          {label}
        </T>
        {hint ? (
          <T variant="footnote" tone="muted">
            {hint}
          </T>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={label}
        trackColor={{ false: 'rgba(255, 255, 255, 0.16)', true: colors.accentStrong }}
        thumbColor={isAndroid ? (value ? colors.accentInk : colors.textMuted) : undefined}
        ios_backgroundColor="rgba(255, 255, 255, 0.16)"
      />
    </View>
  );
}

interface ChoiceRowsProps<V extends string> {
  /** `icon`: shown before the label (a provider's mark…). */
  options: { value: V; label: string; hint?: string; icon?: ReactNode }[];
  value: V | null;
  onChange(value: V): void;
}

/** One choice among a few, as rows with a check mark (put them in a ListCard). */
export function ChoiceRows<V extends string>({ options, value, onChange }: ChoiceRowsProps<V>) {
  return options.map((option) => (
    <Touchable
      key={option.value}
      accessibilityRole="radio"
      accessibilityState={{ selected: option.value === value }}
      onPress={() => onChange(option.value)}
      style={styles.row}
    >
      {option.icon ? <View style={styles.icon}>{option.icon}</View> : null}
      <View style={styles.text}>
        <T variant="body">{option.label}</T>
        {option.hint ? (
          <T variant="footnote" tone="muted">
            {option.hint}
          </T>
        ) : null}
      </View>
      <View style={styles.check}>
        {option.value === value ? <Check size={20} color={colors.text} strokeWidth={2.4} /> : null}
      </View>
    </Touchable>
  ));
}

const styles = StyleSheet.create({
  row: {
    minHeight: isIOS ? 52 : 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: ROW_INSET,
    paddingVertical: 10,
    overflow: 'hidden',
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  value: { flexShrink: 1, maxWidth: '50%', textAlign: 'right' },
  check: { width: 20, alignItems: 'center' },
  icon: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  disabled: { opacity: 0.45 },
});
