import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { ListCard } from '../../../components/list-card';
import { TextArea } from '../../../components/org/field-group';
import { FormError } from '../../../components/org/form-error';
import { FormActions, Screen } from '../../../components/screen';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { SwitchRow } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { problemMessage } from '../../../lib/org-forms';
import { useCreateTeam } from '../../../lib/org-queries';

/** A new team: a group of bots with its shared PC and its files. */
export default function NewTeamScreen() {
  const { t } = useTranslation();
  const create = useCreateTeam();
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [isolated, setIsolated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    create.mutate(
      { name: name.trim(), mission: mission.trim() || undefined, isolated },
      {
        onSuccess: (team) => router.replace(`/team/${team.id}`),
        onError: (err) => setError(problemMessage(err, t('orgAdmin.newTeam.notCreated'), t)),
      },
    );
  };

  return (
    <Screen title={t('orgAdmin.newTeam.title')}>
      <T variant="footnote" tone="muted" style={styles.indent}>
        {t('orgAdmin.newTeam.description')}
      </T>
      <View style={styles.fields}>
        <Field
          label={t('orgAdmin.fields.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('orgAdmin.newTeam.namePlaceholder')}
          maxLength={60}
          autoFocus
          returnKeyType="next"
        />
        <TextArea
          label={t('orgAdmin.fields.mission')}
          value={mission}
          onChangeText={setMission}
          placeholder={t('orgAdmin.newTeam.missionPlaceholder')}
          maxLength={4000}
        />
        <ListCard inset={16}>
          <SwitchRow
            label={t('orgAdmin.fields.isolated')}
            hint={t('orgAdmin.team.isolatedHint')}
            value={isolated}
            onChange={setIsolated}
          />
        </ListCard>
        <T variant="caption" tone="faint" style={styles.indent}>
          {t('orgAdmin.newTeam.note')}
        </T>
      </View>
      <FormError message={error} />
      <FormActions>
        <Button
          label={t('orgAdmin.newTeam.create')}
          onPress={submit}
          loading={create.isPending}
          disabled={!name.trim()}
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
