import type { Bot } from '@mowbot/contract';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { colors, themed, tint } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { reveal } from '../reveal';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

const CHEF_SUGGESTIONS = ['chef1', 'chef2', 'chef3', 'chef4'] as const;
const BOT_SUGGESTIONS = ['bot1', 'bot2', 'bot3'] as const;

/** A fresh conversation: the character, who it is, and a few things to ask. */
export function ChatEmptyState({ bot, onPick }: { bot: Bot; onPick(text: string): void }) {
  const { t } = useTranslation();
  const suggestions = (bot.isChef ? CHEF_SUGGESTIONS : BOT_SUGGESTIONS).map((key) =>
    t(`chat.suggestions.${key}`),
  );
  return (
    <View style={styles.root}>
      <Animated.View entering={reveal(0)}>
        <BotAvatar seed={bot.avatarSeed} size={120} />
      </Animated.View>
      <Animated.View entering={reveal(1)} style={styles.copy}>
        <T variant="title" style={styles.center}>
          {bot.isChef ? t('chat.greetingChef') : t('chat.greeting', { name: bot.name })}
        </T>
        <T tone="muted" style={styles.center}>
          {bot.isChef ? t('chat.chefIntro') : bot.role}
        </T>
        {!bot.isChef && bot.mission ? (
          <T variant="footnote" tone="faint" style={styles.center}>
            {bot.mission}
          </T>
        ) : null}
      </Animated.View>
      <Animated.View entering={reveal(2)} style={styles.chips}>
        {suggestions.map((suggestion) => (
          <Touchable
            key={suggestion}
            accessibilityRole="button"
            onPress={() => onPick(suggestion)}
            style={styles.chip}
          >
            <T variant="footnote" tone="muted">
              {suggestion}
            </T>
          </Touchable>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = themed(() =>
  StyleSheet.create({
    root: { alignItems: 'center', gap: 20, paddingHorizontal: 24 },
    copy: { gap: 6, alignItems: 'center' },
    center: { textAlign: 'center' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
    chip: {
      borderRadius: 9999,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: tint.ink(0.02),
      paddingHorizontal: 14,
      paddingVertical: 8,
      overflow: 'hidden',
    },
  }),
);
