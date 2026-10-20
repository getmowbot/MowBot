import type { BotComputerChoice } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { ListCard } from '../../../components/list-card';
import { FieldGroup, TextArea } from '../../../components/org/field-group';
import { FormError } from '../../../components/org/form-error';
import { FormActions, Screen } from '../../../components/screen';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { newBotBody, problemMessage, SOLO, sortTeams } from '../../../lib/org-forms';
import { useCreateBot } from '../../../lib/org-queries';
import { useTeams } from '../../../lib/queries';

/** A new bot: in a team (on its PC or a dedicated one), or solo with its own PC. */
export default function NewBotScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ team?: string }>();
  const teams = useTeams();
  const create = useCreateBot();
  const sorted = sortTeams(teams.data ?? []);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [mission, setMission] = useState('');
  // null until the user picks: the team it was opened from, else the main team.
  const [picked, setPicked] = useState<string | null>(null);
  const [computer, setComputer] = useState<BotComputerChoice>('team');
  const [lead, setLead] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const team = picked ?? params.team ?? sorted[0]?.id ?? SOLO;
  const solo = team === SOLO;

  const submit = () => {
    setError(null);
    create.mutate(newBotBody({ name, role, mission, team, computer, lead }), {
      onSuccess: (bot) => router.replace({ pathname: '/chat/[botId]', params: { botId: bot.id } }),
      onError: (err) => setError(problemMessage(err, t('orgAdmin.newBot.notCreated'), t)),
    });
  };

  return (
    <Screen title={t('orgAdmin.newBot.title')}>
      <T variant="footnote" tone="muted" style={styles.indent}>
        {t('orgAdmin.newBot.description')}
      </T>
      <View style={styles.fields}>
        <Field
          label={t('orgAdmin.fields.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('orgAdmin.newBot.namePlaceholder')}
          maxLength={40}
          autoFocus
        />
        <Field
          label={t('orgAdmin.fields.role')}
          value={role}
          onChangeText={setRole}
          placeholder={t('orgAdmin.newBot.rolePlaceholder')}
          maxLength={120}
        />
        <TextArea
          label={t('orgAdmin.fields.mission')}
          value={mission}
          onChangeText={setMission}
          placeholder={t('orgAdmin.newBot.missionPlaceholder')}
          maxLength={4000}
        />
        <FieldGroup
          label={t('orgAdmin.fields.team')}
          hint={solo ? t('orgAdmin.newBot.soloNote') : null}
        >
          <ListCard inset={16}>
            <ChoiceRows
              options={[
                ...sorted.map((option) => ({ value: option.id, label: option.name })),
                { value: SOLO, label: t('orgAdmin.fields.solo') },
              ]}
              value={team}
              onChange={setPicked}
            />
          </ListCard>
        </FieldGroup>
        {!solo && (
          <>
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
            <ListCard inset={16}>
              <SwitchRow
                label={t('orgAdmin.newBot.lead')}
                hint={t('orgAdmin.newBot.leadHint')}
                value={lead}
                onChange={setLead}
              />
            </ListCard>
          </>
        )}
      </View>
      <FormError message={error} />
      <FormActions>
        <Button
          label={t('orgAdmin.newBot.create')}
          onPress={submit}
          loading={create.isPending}
          disabled={!name.trim() || !role.trim()}
        />
        <Button label={t('common.cancel')} variant="secondary" onPress={() => router.back()} />
      </FormActions>
    </Screen>
  );
}

const styles = StyleSheet.create({
  indent: { paddingHorizontal: 4 },
  fields: { gap: 16 },
});
