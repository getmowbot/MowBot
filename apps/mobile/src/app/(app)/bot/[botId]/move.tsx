import type { Bot, BotComputerChoice, Computer, Team } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { BotAvatar } from '../../../../components/bot-avatar';
import { ListCard } from '../../../../components/list-card';
import { FieldGroup } from '../../../../components/org/field-group';
import { FormError } from '../../../../components/org/form-error';
import { FormActions, Screen } from '../../../../components/screen';
import { Button } from '../../../../components/ui/button';
import { ChoiceRows } from '../../../../components/ui/rows';
import { T } from '../../../../components/ui/text';
import {
  moveBody,
  moveUnchanged,
  placementOf,
  problemMessage,
  SOLO,
  sortTeams,
} from '../../../../lib/org-forms';
import { useMoveBot } from '../../../../lib/org-queries';
import { useBots, useComputers, useTeams } from '../../../../lib/queries';
import { colors } from '../../../../theme';

function MoveForm({
  bot,
  teams,
  pc,
  preset,
}: {
  bot: Bot;
  teams: Team[];
  pc: Computer | undefined;
  /** A team to preselect (opened from that team's screen). */
  preset: string | undefined;
}) {
  const { t } = useTranslation();
  const move = useMoveBot();
  const current = placementOf(bot, pc);
  const [team, setTeam] = useState(() =>
    preset && (preset === SOLO || teams.some((option) => option.id === preset))
      ? preset
      : current.team,
  );
  const [computer, setComputer] = useState<BotComputerChoice>(current.computer);
  const [error, setError] = useState<string | null>(null);
  const solo = team === SOLO;
  const unchanged = moveUnchanged(current, team, computer);
  const label = (value: string, name: string) =>
    value === current.team ? t('orgAdmin.move.current', { team: name }) : name;

  const submit = () => {
    setError(null);
    move.mutate(
      { id: bot.id, body: moveBody(team, computer) },
      {
        onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/bots')),
        onError: (err) => setError(problemMessage(err, t('orgAdmin.move.notMoved'), t)),
      },
    );
  };

  return (
    <Screen title={t('orgAdmin.move.title')}>
      <View style={styles.hero}>
        <BotAvatar seed={bot.avatarSeed} size={44} still />
        <View style={styles.heroText}>
          <T variant="headline" numberOfLines={1}>
            {bot.name}
          </T>
          <T variant="footnote" tone="muted">
            {t('orgAdmin.move.description')}
          </T>
        </View>
      </View>
      <View style={styles.fields}>
        <FieldGroup
          label={t('orgAdmin.fields.team')}
          hint={solo ? t('orgAdmin.move.soloNote') : null}
        >
          <ListCard inset={16}>
            <ChoiceRows
              options={[
                ...teams.map((option) => ({
                  value: option.id,
                  label: label(option.id, option.name),
                })),
                { value: SOLO, label: label(SOLO, t('orgAdmin.fields.solo')) },
              ]}
              value={team}
              onChange={setTeam}
            />
          </ListCard>
        </FieldGroup>
        {!solo && (
          <FieldGroup label={t('orgAdmin.fields.computer')}>
            <ListCard inset={16}>
              <ChoiceRows<BotComputerChoice>
                options={[
                  {
                    value: 'team',
                    label: t('orgAdmin.links.teamPc'),
                    hint: t('orgAdmin.newBot.teamPcHint'),
                  },
                  {
                    value: 'dedicated',
                    label: t('orgAdmin.newBot.dedicatedPc'),
                    hint: t('orgAdmin.newBot.dedicatedPcHint'),
                  },
                ]}
                value={computer}
                onChange={setComputer}
              />
            </ListCard>
          </FieldGroup>
        )}
      </View>
      <FormError message={error} />
      <FormActions>
        <Button
          label={t('orgAdmin.move.move')}
          onPress={submit}
          loading={move.isPending}
          disabled={unchanged}
        />
        <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
      </FormActions>
    </Screen>
  );
}

/** Moves a bot to another team (or solo), on the team's PC or a dedicated one. */
export default function MoveBotScreen() {
  const { botId, team } = useLocalSearchParams<{ botId: string; team?: string }>();
  const { t } = useTranslation();
  const bots = useBots();
  const teams = useTeams();
  const computers = useComputers();
  const bot = bots.data?.find((item) => item.id === botId);

  if (!bot || bot.isChef || !teams.data || computers.isPending) {
    const loading = bots.isPending || teams.isPending || computers.isPending;
    return (
      <Screen title={t('orgAdmin.move.title')}>
        {loading ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : (
          <T tone="muted" style={styles.indent}>
            {bot?.isChef ? t('orgAdmin.problems.chef') : t('common.botNotFound')}
          </T>
        )}
      </Screen>
    );
  }
  return (
    <MoveForm
      key={bot.id}
      bot={bot}
      teams={sortTeams(teams.data)}
      pc={computers.data?.find((c) => c.id === bot.computerId)}
      preset={team}
    />
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4 },
  heroText: { flex: 1, minWidth: 0, gap: 2 },
  indent: { paddingHorizontal: 4 },
  fields: { gap: 16 },
});
