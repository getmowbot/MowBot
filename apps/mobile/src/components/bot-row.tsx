import type { Bot } from '@mowbot/contract';
import { router } from 'expo-router';
import { ChevronRight, Crown } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { type BotMood, moodOf, statusLabel } from '../lib/bot-mood';
import { isIOS } from '../lib/platform';
import { useLiveMessage } from '../lib/queries';
import { colors } from '../theme';
import { BotAvatar } from './bot-avatar';
import { ShimmerText } from './ui/shimmer-text';
import { T } from './ui/text';
import { Touchable } from './ui/touchable';

const BUSY: ReadonlySet<BotMood> = new Set(['thinking', 'working', 'waiting']);

export function openChat(bot: Pick<Bot, 'id'>) {
  router.push({ pathname: '/chat/[botId]', params: { botId: bot.id } });
}

/** The bot's live mood: its status plus what its current answer is doing (from events). */
export function useBotMood(bot: Bot): BotMood {
  const live = useLiveMessage(bot.id);
  return moodOf(bot, live);
}

/** One line of what a bot is up to: its live status while busy, its role otherwise. */
export function BotStatusLine({ bot, mood }: { bot: Bot; mood: BotMood }) {
  const { t } = useTranslation();
  if (BUSY.has(mood)) return <ShimmerText>{statusLabel(bot, mood, t)}</ShimmerText>;
  if (mood === 'error' || mood === 'sleeping') {
    return (
      <T variant="footnote" tone={mood === 'error' ? 'danger' : 'faint'} numberOfLines={1}>
        {statusLabel(bot, mood, t)}
      </T>
    );
  }
  return (
    <T variant="footnote" tone="faint" numberOfLines={1}>
      {bot.role}
    </T>
  );
}

interface Props {
  bot: Bot;
  lead?: boolean;
  size?: number;
}

/** A bot in a list; opens its chat. */
export function BotRow({ bot, lead = false, size = 40 }: Props) {
  const { t } = useTranslation();
  const mood = useBotMood(bot);
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}, ${statusLabel(bot, mood, t)}`}
      onPress={() => openChat(bot)}
      style={styles.row}
    >
      <BotAvatar seed={bot.avatarSeed} size={size} mood={mood} />
      <View style={styles.text}>
        <View style={styles.name}>
          <T variant="headline" numberOfLines={1} style={styles.shrink}>
            {bot.name}
          </T>
          {lead && <Crown size={13} color={colors.textMuted} accessibilityLabel={t('org.lead')} />}
        </View>
        <BotStatusLine bot={bot} mood={mood} />
      </View>
      {isIOS && <ChevronRight size={16} color={colors.textFaint} />}
    </Touchable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 60,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  name: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
});
