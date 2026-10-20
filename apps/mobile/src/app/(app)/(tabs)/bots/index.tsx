import type { Bot, Team } from '@mowbot/contract';
import { Lock, MessageCircle, WifiOff } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { BotAvatar, TeamAvatar } from '../../../../components/bot-avatar';
import { BotRow, BotStatusLine, openChat, useBotMood } from '../../../../components/bot-row';
import { ListCard } from '../../../../components/list-card';
import { reveal } from '../../../../components/reveal';
import { Section, TabScroll } from '../../../../components/tab-scroll';
import { Button } from '../../../../components/ui/button';
import { Surface } from '../../../../components/ui/surface';
import { T } from '../../../../components/ui/text';
import { Touchable } from '../../../../components/ui/touchable';
import { useLiveConnection } from '../../../../lib/events';
import { isAndroid } from '../../../../lib/platform';
import { useBots, useTeams } from '../../../../lib/queries';
import { colors, shape } from '../../../../theme';

/** True once the event stream has been down for a moment (not during the first connect). */
function useOffline(): boolean {
  const connected = useLiveConnection();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (connected) {
      setOffline(false);
      return;
    }
    const timer = setTimeout(() => setOffline(true), 2_500);
    return () => clearTimeout(timer);
  }, [connected]);
  return offline;
}

function ChefCard({ chef }: { chef: Bot }) {
  const { t } = useTranslation();
  const mood = useBotMood(chef);
  return (
    <Touchable accessibilityRole="button" onPress={() => openChat(chef)} style={styles.chefPress}>
      <Surface style={styles.chef}>
        <BotAvatar seed={chef.avatarSeed} size={72} mood={mood} />
        <View style={styles.chefText}>
          <T variant="title" numberOfLines={1}>
            {chef.name}
          </T>
          <BotStatusLine bot={chef} mood={mood} />
          <View style={styles.chefCta}>
            <MessageCircle size={14} color={colors.textMuted} />
            <T variant="footnote" tone="muted">
              {t('home.talkToChef')}
            </T>
          </View>
        </View>
      </Surface>
    </Touchable>
  );
}

function TeamSection({ team, members }: { team: Team; members: Bot[] }) {
  const { t } = useTranslation();
  const sorted = [...members].sort(
    (a, b) => Number(b.id === team.leadBotId) - Number(a.id === team.leadBotId),
  );
  return (
    <View style={styles.team}>
      <View style={styles.teamHeader}>
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={24} />
        <T variant="headline" numberOfLines={1} style={styles.shrink}>
          {team.name}
        </T>
        {team.isolated && (
          <Lock size={13} color={colors.textMuted} accessibilityLabel={t('org.isolated')} />
        )}
      </View>
      {sorted.length > 0 ? (
        <ListCard>
          {sorted.map((bot) => (
            <BotRow key={bot.id} bot={bot} lead={bot.id === team.leadBotId} />
          ))}
        </ListCard>
      ) : (
        <T variant="footnote" tone="faint" style={styles.indent}>
          {t('home.noBots')}
        </T>
      )}
    </View>
  );
}

/** The Chef on top, then every team with its bots (live status), then the solo bots. */
export default function HomeScreen() {
  const { t } = useTranslation();
  const bots = useBots();
  const teams = useTeams();
  const offline = useOffline();

  if (bots.isPending || teams.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (bots.isError || teams.isError) {
    return (
      <View style={styles.center}>
        <T tone="muted">{t('errors.generic')}</T>
        <Button
          label={t('common.retry')}
          variant="secondary"
          onPress={() => {
            void bots.refetch();
            void teams.refetch();
          }}
        />
      </View>
    );
  }

  const all = bots.data;
  const chef = all.find((b) => b.isChef);
  const solo = all.filter((b) => !b.teamId);
  // The main team comes first; it only shows when someone besides the Chef is in it.
  const visibleTeams = [...teams.data]
    .sort((a, b) => Number(b.isMain) - Number(a.isMain))
    .map((team) => ({ team, members: all.filter((b) => b.teamId === team.id && !b.isChef) }))
    .filter(({ team, members }) => !team.isMain || members.length > 0);

  return (
    <TabScroll onRefresh={() => Promise.all([bots.refetch(), teams.refetch()])}>
      {offline && (
        <Animated.View entering={reveal()} style={styles.offline}>
          <WifiOff size={14} color={colors.textMuted} />
          <T variant="footnote" tone="muted">
            {t('home.offline')}
          </T>
        </Animated.View>
      )}

      {chef && <ChefCard chef={chef} />}

      <Section title={t('home.teams')}>
        {visibleTeams.length === 0 ? (
          <T variant="footnote" tone="faint" style={styles.indent}>
            {t('home.empty')}
          </T>
        ) : (
          <View style={styles.teams}>
            {visibleTeams.map(({ team, members }) => (
              <TeamSection key={team.id} team={team} members={members} />
            ))}
          </View>
        )}
      </Section>

      {solo.length > 0 && (
        <Section title={t('home.solo')}>
          <ListCard>
            {solo.map((bot) => (
              <BotRow key={bot.id} bot={bot} />
            ))}
          </ListCard>
        </Section>
      )}
    </TabScroll>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: colors.background,
  },
  offline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  chefPress: { borderRadius: shape.card, overflow: isAndroid ? 'hidden' : 'visible' },
  chef: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14 },
  chefText: { flex: 1, minWidth: 0, gap: 3 },
  chefCta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  teams: { gap: 18 },
  team: { gap: 8 },
  teamHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  shrink: { flexShrink: 1 },
  indent: { paddingHorizontal: 4 },
});
