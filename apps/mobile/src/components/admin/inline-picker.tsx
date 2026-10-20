import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '../../theme';
import { ListCard } from '../list-card';
import { ChoiceRows, ListRow, ROW_INSET } from '../ui/rows';
import { T } from '../ui/text';

interface Props<V extends string> {
  label: string;
  options: { value: V; label: string; hint?: string }[];
  value: V | null;
  /** Shown while nothing is chosen. */
  placeholder: string;
  onChange(value: V): void;
}

/**
 * A row showing the current choice that unfolds its choices underneath, like the inline pickers
 * of iOS Settings. Scrolls with the form, so it stays usable with twenty bots (a menu would not).
 */
export function InlinePicker<V extends string>({
  label,
  options,
  value,
  placeholder,
  onChange,
}: Props<V>) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <ListCard inset={ROW_INSET}>
      <ListRow
        label={label}
        chevron={false}
        onPress={() => setOpen((shown) => !shown)}
        accessory={
          <View style={styles.value}>
            <T variant="callout" tone="muted" numberOfLines={1} style={styles.text}>
              {current?.label ?? placeholder}
            </T>
            <Chevron size={18} color={colors.textFaint} />
          </View>
        }
      />
      {open ? (
        <ChoiceRows
          options={options}
          value={value}
          onChange={(next) => {
            setOpen(false);
            onChange(next);
          }}
        />
      ) : null}
    </ListCard>
  );
}

const styles = StyleSheet.create({
  value: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '60%' },
  text: { flexShrink: 1, textAlign: 'right' },
});
