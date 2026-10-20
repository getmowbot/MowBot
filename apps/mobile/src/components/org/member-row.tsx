import type { Bot } from '@mowbot/contract';
import { router } from 'expo-router';
import { Crown, Settings2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { statusLabel } from '../../lib/bot-mood';
import { colors } from '../../theme';
import { BotAvatar } from '../bot-avatar';
import { BotStatusLine, openChat, useBotMood } from '../bot-row';
import { IconButton } from '../ui/button';
import { T } from '../ui/text';
import { Touchable } from '../ui/touchable';

/** A team member: the row opens its chat, the gear its settings. Lines up with BotRow. */
export function MemberRow({ bot, lead = false }: { bot: Bot; lead?: boolean }) {
  const { t } = useTranslation();
  const mood = useBotMood(bot);
  return (
    <View style={styles.row}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${bot.name}, ${statusLabel(bot, mood, t)}`}
        onPress={() => openChat(bot)}
        style={styles.main}
      >
        <BotAvatar seed={bot.avatarSeed} size={40} mood={mood} />
        <View style={styles.text}>
          <View style={styles.name}>
            <T variant="headline" numberOfLines={1} style={styles.shrink}>
              {bot.name}
            </T>
            {lead && (
              <Crown size={13} color={colors.textMuted} accessibilityLabel={t('org.lead')} />
            )}
          </View>
          <BotStatusLine bot={bot} mood={mood} />
        </View>
      </Touchable>
      <IconButton
        icon={Settings2}
        label={t('orgAdmin.settingsOf', { name: bot.name })}
        color={colors.textMuted}
        onPress={() => router.push(`/bot/${bot.id}`)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 10,
    minHeight: 60,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  name: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
});
