import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ListCard } from '../../../components/list-card';
import { BotPickRow, PICK_ROW_INSET } from '../../../components/org/bot-pick-row';
import { FieldGroup, TextArea } from '../../../components/org/field-group';
import { FormError } from '../../../components/org/form-error';
import { FormActions, Screen } from '../../../components/screen';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { T } from '../../../components/ui/text';
import { problemMessage } from '../../../lib/org-forms';
import { useCreateTask } from '../../../lib/org-queries';
import { useBots } from '../../../lib/queries';
import { colors } from '../../../theme';

/** The user gives a bot a task (`?bot=` preselects it); the bot wakes up to do it. */
export default function NewTaskScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ bot?: string }>();
  const bots = useBots();
  const create = useCreateTask();
  const [assignee, setAssignee] = useState<string | null>(params.bot ?? null);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = bots.data ?? [];
  const chosen = list.some((bot) => bot.id === assignee) ? assignee : null;

  const submit = () => {
    if (!chosen) return;
    setError(null);
    create.mutate(
      { assigneeBotId: chosen, title: title.trim(), details: details.trim() || undefined },
      {
        onSuccess: () => (router.canGoBack() ? router.back() : router.replace('/activity')),
        onError: (err) => setError(problemMessage(err, t('orgAdmin.task.notCreated'), t)),
      },
    );
  };

  return (
    <Screen title={t('orgAdmin.task.title')}>
      <T variant="footnote" tone="muted" style={styles.indent}>
        {t('orgAdmin.task.description')}
      </T>
      <View style={styles.fields}>
        <Field
          label={t('orgAdmin.task.task')}
          value={title}
          onChangeText={setTitle}
          placeholder={t('orgAdmin.task.taskPlaceholder')}
          maxLength={200}
          autoFocus={Boolean(params.bot)}
        />
        <TextArea
          label={t('orgAdmin.task.details')}
          value={details}
          onChangeText={setDetails}
          placeholder={t('orgAdmin.task.detailsPlaceholder')}
          maxLength={8000}
        />
        <FieldGroup label={t('orgAdmin.task.assignee')}>
          {bots.isPending ? (
            <ActivityIndicator color={colors.textMuted} />
          ) : (
            <ListCard inset={PICK_ROW_INSET}>
              {list.map((bot) => (
                <BotPickRow
                  key={bot.id}
                  bot={bot}
                  hint={bot.role}
                  selected={bot.id === chosen}
                  onPress={() => setAssignee(bot.id)}
                />
              ))}
            </ListCard>
          )}
        </FieldGroup>
      </View>
      <FormError message={error} />
      <FormActions>
        <Button
          label={t('orgAdmin.task.assign')}
          onPress={submit}
          loading={create.isPending}
          disabled={!chosen || !title.trim()}
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
