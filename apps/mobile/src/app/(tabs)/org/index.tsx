import type { Bot, Computer, Team } from '@mowbot/contract';
import { Lock } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { BotAvatar, TeamAvatar } from '../../../components/bot-avatar';
import { BotRow, openChat, useBotMood } from '../../../components/bot-row';
import { ListCard } from '../../../components/list-card';
import { Section, TabScroll } from '../../../components/tab-scroll';
import { Surface } from '../../../components/ui/surface';
import { T } from '../../../components/ui/text';
import { Touchable } from '../../../components/ui/touchable';
import { useBots, useComputers, useTeams } from '../../../lib/queries';
import { colors } from '../../../theme';

const PC_COLORS: Record<Computer['status'], string> = {
  running: colors.accentStrong,
  starting: colors.warning,
  stopping: colors.warning,
  stopped: colors.textFaint,
  error: colors.danger,
};

function PcStatus({ computer }: { computer: Computer | undefined }) {
  const { t } = useTranslation();
  if (!computer) return null;
  return (
    <View style={styles.pc}>
      <View style={[styles.dot, { backgroundColor: PC_COLORS[computer.status] }]} />
      <T variant="caption" tone="muted">
        {t(`org.pc.${computer.status}`)}
      </T>
    </View>
  );
}

function TeamCard({
  team,
  members,
  computer,
}: {
  team: Team;
  members: Bot[];
  computer: Computer | undefined;
}) {
  const { t } = useTranslation();
  const sorted = [...members].sort(
    (a, b) => Number(b.id === team.leadBotId) - Number(a.id === team.leadBotId),
  );
  return (
    <Surface>
      <View style={styles.teamHeader}>
        <TeamAvatar seeds={members.map((b) => b.avatarSeed)} size={40} />
        <View style={styles.teamText}>
          <View style={styles.row}>
            <T variant="headline" numberOfLines={1} style={styles.shrink}>
              {team.name}
            </T>
            {team.isolated && <Lock size={13} color={colors.textMuted} />}
            {team.isolated && (
              <T variant="caption" tone="muted">
                {t('org.isolated')}
              </T>
            )}
          </View>
          <T variant="footnote" tone="muted" numberOfLines={3}>
            {team.mission ?? t('org.members', { count: members.length })}
          </T>
          <PcStatus computer={computer} />
        </View>
      </View>
      <View style={styles.divider} />
      {sorted.length > 0 ? (
        sorted.map((bot) => (
          <BotRow key={bot.id} bot={bot} lead={bot.id === team.leadBotId} size={34} />
        ))
      ) : (
        <T variant="footnote" tone="faint" style={styles.noBots}>
          {t('org.noBots')}
        </T>
      )}
    </Surface>
  );
}

function ChefNode({ chef }: { chef: Bot }) {
  const mood = useBotMood(chef);
  return (
    <Touchable accessibilityRole="button" onPress={() => openChat(chef)} style={styles.chef}>
      <BotAvatar seed={chef.avatarSeed} size={84} mood={mood} />
      <T variant="headline">{chef.name}</T>
    </Touchable>
  );
}

/** Org chart, read-only: the Chef, the teams under it with their bots, then the solo bots. */
export default function OrgScreen() {
  const { t } = useTranslation();
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();

  if (bots.isPending || teams.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  const all = bots.data ?? [];
  const chef = all.find((b) => b.isChef);
  const solo = all.filter((b) => !b.teamId);
  const sortedTeams = [...(teams.data ?? [])].sort((a, b) => Number(b.isMain) - Number(a.isMain));
  const computerOf = (id: string | null) => computers.data?.find((c) => c.id === id);

  return (
    <TabScroll
      onRefresh={() => Promise.all([bots.refetch(), teams.refetch(), computers.refetch()])}
    >
      <T variant="footnote" tone="muted" style={styles.indent}>
        {t('org.intro')}
      </T>
      {chef && <ChefNode chef={chef} />}
      <View style={styles.teams}>
        {sortedTeams.map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            members={all.filter((b) => b.teamId === team.id)}
            computer={computerOf(team.computerId)}
          />
        ))}
      </View>
      {solo.length > 0 && (
        <Section title={t('org.solo')}>
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
    backgroundColor: colors.background,
  },
  indent: { paddingHorizontal: 4 },
  chef: { alignItems: 'center', gap: 6, alignSelf: 'center', paddingHorizontal: 16 },
  teams: { gap: 14 },
  teamHeader: { flexDirection: 'row', gap: 12, padding: 14 },
  teamText: { flex: 1, minWidth: 0, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  pc: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginHorizontal: 14,
  },
  noBots: { padding: 14 },
});
