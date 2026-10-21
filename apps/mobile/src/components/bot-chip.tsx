import { botGenome } from '@mowbot/design';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import type { ChipBot } from '../lib/incoming';
import { colors } from '../theme';
import { BotAvatar } from './bot-avatar';

/**
 * A bot named in a line of text (nested in a Text): its little character then its name, in its
 * color (`plain`: muted). Opens its chat; a deleted bot is only named.
 */
export function BotChip({ bot, plain = false }: { bot: ChipBot; plain?: boolean }) {
  const { id } = bot;
  return (
    <Text
      style={[styles.chip, { color: plain ? colors.textMuted : botGenome(bot.avatarSeed).color }]}
      onPress={
        id ? () => router.push({ pathname: '/chat/[botId]', params: { botId: id } }) : undefined
      }
    >
      <View style={styles.avatar}>
        <BotAvatar seed={bot.avatarSeed} size={14} still />
      </View>
      {bot.name}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: { fontWeight: '600' },
  // An inline view sits on the baseline: lowered to the middle of the letters.
  avatar: { width: 18, height: 14, paddingRight: 4, transform: [{ translateY: 2.5 }] },
});
