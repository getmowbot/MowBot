import type { Bot, Computer, Team } from '@mowbot/contract';
import { router, Stack } from 'expo-router';
import {
  ChevronDown,
  Lock,
  MessageCircle,
  Plus,
  UserPlus,
  Users,
  WifiOff,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { BotAvatar, TeamAvatar } from '../../../../components/bot-avatar';
import { BotRow, BotStatusLine, openChat, useBotMood } from '../../../../components/bot-row';
import { ListCard } from '../../../../components/list-card';
import { PcStatus } from '../../../../components/org/pc-status';
import { reveal } from '../../../../components/reveal';
import { Section, TabScroll } from '../../../../components/tab-scroll';
import { Button, IconButton } from '../../../../components/ui/button';
import { Surface } from '../../../../components/ui/surface';
import { T } from '../../../../components/ui/text';
import { Touchable } from '../../../../components/ui/touchable';
import { toggleTeam, useCollapsedTeams } from '../../../../lib/collapsed-teams';
import { useLiveConnection } from '../../../../lib/events';
import { openOptions } from '../../../../lib/options-menu';
import { orgChart } from '../../../../lib/org-forms';
import { isAndroid, isIOS } from '../../../../lib/platform';
import { useBots, useComputers, useTeams } from '../../../../lib/queries';
import { colors, shape, springs, themed } from '../../../../theme';

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

/** New team / new bot, from the header's "+". */
function useAddMenu(): () => void {
  const { t } = useTranslation();
  return () =>
    openOptions({
      options: [
        {
          label: t('orgAdmin.newTeam.title'),
          icon: Users,
          onPress: () => router.push('/team/new'),
        },
        {
          label: t('orgAdmin.newBot.title'),
          icon: UserPlus,
          onPress: () => router.push('/bot/new'),
        },
      ],
    });
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

/** The chevron that folds a team: down when its bots show, turned right when folded. */
function FoldChevron({ folded }: { folded: boolean }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: withSpring(folded ? '-90deg' : '0deg', springs.snappy) }],
  }));
  return (
    <Animated.View style={style}>
      <ChevronDown size={18} color={colors.textMuted} />
    </Animated.View>
  );
}

/** The team's own row: opens the team (settings, PC, files, members); its chevron folds it. */
function TeamHeader({
  team,
  members,
  size,
  computer,
  chef,
  folded,
}: {
  team: Team;
  members: Bot[];
  size: number;
  computer: Computer | undefined;
  /** The main team's face when the Chef is alone in it (it is listed apart). */
  chef: Bot | undefined;
  /** Its bots are hidden. */
  folded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.teamRow}>
      <Touchable
        accessibilityRole="button"
        accessibilityHint={t('orgAdmin.tab.openTeam')}
        onPress={() => router.push(`/team/${team.id}`)}
        style={styles.teamHeader}
      >
        <TeamAvatar
          seeds={
            members.length > 0
              ? members.map((b) => b.avatarSeed)
              : team.isMain && chef
                ? [chef.avatarSeed]
                : []
          }
          size={40}
        />
        <View style={styles.teamText}>
          <View style={styles.teamName}>
            <T variant="headline" numberOfLines={1} style={styles.shrink}>
              {team.name}
            </T>
            {team.isolated && (
              <Lock size={13} color={colors.textMuted} accessibilityLabel={t('org.isolated')} />
            )}
          </View>
          <PcStatus computer={computer} suffix={t('org.members', { count: size })} />
        </View>
      </Touchable>
      {members.length > 0 && (
        <Touchable
          accessibilityRole="button"
          accessibilityState={{ expanded: !folded }}
          accessibilityLabel={
            folded
              ? t('orgAdmin.tab.unfold', { name: team.name })
              : t('orgAdmin.tab.fold', { name: team.name })
          }
          onPress={() => toggleTeam(team.id)}
          hitSlop={8}
          borderless
          style={styles.fold}
        >
          <FoldChevron folded={folded} />
        </Touchable>
      )}
    </View>
  );
}

/** Bots: the Chef on top, every team with its bots (live status), then the solo bots. */
export default function BotsScreen() {
  const { t } = useTranslation();
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();
  const offline = useOffline();
  const add = useAddMenu();
  const collapsed = useCollapsedTeams();

  const header = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <IconButton
            icon={Plus}
            label={t('orgAdmin.tab.add')}
            onPress={add}
            size={isIOS ? 36 : 40}
          />
        ),
      }}
    />
  );

  if (bots.isPending || teams.isPending) {
    return (
      <View style={styles.center}>
        {header}
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }
  if (bots.isError || teams.isError) {
    return (
      <View style={styles.center}>
        {header}
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

  const chart = orgChart(bots.data, teams.data);
  const computerOf = (id: string | null) => computers.data?.find((c) => c.id === id);

  return (
    <TabScroll
      onRefresh={() => Promise.all([bots.refetch(), teams.refetch(), computers.refetch()])}
    >
      {header}
      {offline && (
        <Animated.View entering={reveal()} style={styles.offline}>
          <WifiOff size={14} color={colors.textMuted} />
          <T variant="footnote" tone="muted">
            {t('home.offline')}
          </T>
        </Animated.View>
      )}

      {chart.chef && <ChefCard chef={chart.chef} />}

      <Section title={t('home.teams')}>
        <View style={styles.teams}>
          {chart.teams.map(({ team, members, size }) => (
            <ListCard key={team.id}>
              <TeamHeader
                team={team}
                members={members}
                size={size}
                computer={computerOf(team.computerId)}
                chef={chart.chef}
                folded={collapsed.has(team.id)}
              />
              {!collapsed.has(team.id) &&
                members.map((bot) => (
                  <Animated.View key={bot.id} entering={reveal()}>
                    <BotRow bot={bot} lead={bot.id === team.leadBotId} />
                  </Animated.View>
                ))}
            </ListCard>
          ))}
        </View>
        {chart.teams.length <= 1 && (
          <T variant="footnote" tone="faint" style={styles.indent}>
            {t('home.empty')}
          </T>
        )}
      </Section>

      {chart.solo.length > 0 && (
        <Section title={t('home.solo')}>
          <ListCard>
            {chart.solo.map((bot) => (
              <BotRow key={bot.id} bot={bot} />
            ))}
          </ListCard>
        </Section>
      )}

      <T variant="footnote" tone="faint" style={styles.indent}>
        {t('org.intro')}
      </T>
    </TabScroll>
  );
}

const styles = themed(() =>
  StyleSheet.create({
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
    teams: { gap: 14 },
    // The team's button, then its fold chevron beside it (not inside: one button each).
    teamRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
    teamHeader: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 12,
      minHeight: 64,
    },
    teamText: { flex: 1, minWidth: 0, gap: 3 },
    fold: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    teamName: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    shrink: { flexShrink: 1 },
    indent: { paddingHorizontal: 4 },
  }),
);
