import type { Bot } from '@mowbot/contract';
import { Check, ChevronRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { colors } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/** Divider inset of a ListCard of BotPickRows (past the avatar). */
export const PICK_ROW_INSET = 16 + 32 + 12;

/**
 * A bot to choose in a list: a check mark when it is the choice (`selected` given), a chevron
 * when choosing it opens something.
 */
export function BotPickRow({
  bot,
  hint,
  selected,
  onPress,
}: {
  bot: Bot;
  hint?: string;
  selected?: boolean;
  onPress(): void;
}) {
  const choice = selected !== undefined;
  return (
    <Touchable
      accessibilityRole={choice ? 'radio' : 'button'}
      accessibilityState={choice ? { selected } : undefined}
      onPress={onPress}
      style={styles.row}
    >
      <BotAvatar seed={bot.avatarSeed} size={32} still />
      <View style={styles.text}>
        <T variant="body" numberOfLines={1}>
          {bot.name}
        </T>
        {hint ? (
          <T variant="footnote" tone="muted" numberOfLines={1}>
            {hint}
          </T>
        ) : null}
      </View>
      {choice ? (
        <View style={styles.check}>
          {selected ? <Check size={20} color={colors.text} strokeWidth={2.4} /> : null}
        </View>
      ) : (
        <ChevronRight size={18} color={colors.textFaint} />
      )}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  check: { width: 20, alignItems: 'center' },
});
