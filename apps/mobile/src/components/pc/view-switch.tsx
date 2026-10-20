import * as Haptics from 'expo-haptics';
import { ScrollView, StyleSheet } from 'react-native';
import { isAndroid } from '../../lib/platform';
import { colors, spacing } from '../../theme';
import { Segmented } from '../ui/segmented';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

interface Props<V extends string> {
  options: { value: V; label: string }[];
  value: V;
  onChange(value: V): void;
  label: string;
}

/** Same height as the segmented control, so both look alike. */
const HEIGHT = isAndroid ? 40 : 36;

/**
 * Which view of the PC is shown: the screen or a bot's window. Two choices fit a segmented
 * control; more become a row of pills that scrolls (bot names are long).
 */
export function ViewSwitch<V extends string>({ options, value, onChange, label }: Props<V>) {
  if (options.length <= 2) {
    return <Segmented options={options} value={value} onChange={onChange} label={label} />;
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={styles.bleed}
      contentContainerStyle={styles.pills}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Touchable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onAccent={selected}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync();
              onChange(option.value);
            }}
            style={[styles.pill, selected ? styles.selected : styles.idle]}
          >
            <T
              variant="footnote"
              numberOfLines={1}
              style={[styles.label, { color: selected ? colors.accentInk : colors.textMuted }]}
            >
              {option.label}
            </T>
          </Touchable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // The row scrolls edge to edge while its first pill lines up with the content.
  bleed: { marginHorizontal: -spacing.lg, flexGrow: 0 },
  pills: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  pill: {
    height: HEIGHT,
    paddingHorizontal: 16,
    borderRadius: HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  idle: { borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.22)' },
  selected: { backgroundColor: colors.accentStrong },
  label: { fontWeight: '600' },
});
