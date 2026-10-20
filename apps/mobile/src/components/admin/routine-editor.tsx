import type { Bot, Routine } from '@mowbot/contract';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { adminError, useCreateRoutine, useSystem, useUpdateRoutine } from '../../lib/admin-queries';
import {
  checkTrigger,
  describeCron,
  routineProblem,
  sameTrigger,
  TRIGGER_TYPES,
  type TriggerDraft,
  type TriggerType,
  triggerDraft,
} from '../../lib/routine-form';
import { fonts } from '../../theme';
import { ListCard } from '../list-card';
import { FormActions } from '../screen';
import { Section } from '../tab-scroll';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { ChoiceRows, ROW_INSET, SwitchRow } from '../ui/rows';
import { InlinePicker } from './inline-picker';
import { Caption, FormError, Note } from './parts';

interface Props {
  bots: Bot[];
  /** Editing this routine; otherwise a new one. */
  routine?: Routine;
  /** New routine: the bot picked beforehand (from a bot's page). */
  botId?: string;
  onDone(routine: Routine): void;
}

function defaultBot(bots: Bot[], botId: string | undefined): string | null {
  if (botId && bots.some((b) => b.id === botId)) return botId;
  return (bots.find((b) => b.isChef) ?? bots[0])?.id ?? null;
}

/** Name, instruction, trigger and notification of a routine, like the web's form (plus editing). */
export function RoutineEditor({ bots, routine, botId: initialBot, onDone }: Props) {
  const { t } = useTranslation();
  const create = useCreateRoutine();
  const update = useUpdateRoutine();
  const system = useSystem();
  const [botId, setBotId] = useState(() => routine?.botId ?? defaultBot(bots, initialBot));
  const [name, setName] = useState(routine?.name ?? '');
  const [prompt, setPrompt] = useState(routine?.prompt ?? '');
  const [draft, setDraft] = useState<TriggerDraft>(() => triggerDraft(routine?.trigger));
  const [notify, setNotify] = useState(routine ? !routine.silent : false);
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const patch = (next: Partial<TriggerDraft>) => setDraft((current) => ({ ...current, ...next }));
  const trigger = checkTrigger(draft);
  const changes = routine && {
    name: name.trim() !== routine.name,
    prompt: prompt.trim() !== routine.prompt,
    trigger: !trigger.ok || !sameTrigger(trigger.value, routine.trigger),
    silent: notify === routine.silent,
  };
  const ready = Boolean(name.trim() && prompt.trim() && botId);
  const dirty = changes ? Object.values(changes).some(Boolean) : ready;

  const submit = () => {
    const problem = routineProblem({ botId, name, prompt, trigger });
    if (problem) {
      setError(t(`appAdmin.routines.problems.${problem}`));
      return;
    }
    if (!botId || !trigger.ok) return;
    setError(null);
    if (routine && changes) {
      update.mutate(
        {
          id: routine.id,
          ...(changes.name ? { name: name.trim() } : {}),
          ...(changes.prompt ? { prompt: prompt.trim() } : {}),
          ...(changes.trigger ? { trigger: trigger.value } : {}),
          ...(changes.silent ? { silent: !notify } : {}),
        },
        {
          onSuccess: onDone,
          onError: (err) => setError(adminError(err, t('appAdmin.routines.notSaved'))),
        },
      );
      return;
    }
    create.mutate(
      {
        botId,
        name: name.trim(),
        prompt: prompt.trim(),
        trigger: trigger.value,
        silent: !notify,
      },
      {
        onSuccess: onDone,
        onError: (err) => setError(adminError(err, t('appAdmin.routines.notCreated'))),
      },
    );
  };

  const cronPreview = draft.type === 'cron' ? describeCron(draft.cron, t) : null;
  const zone = system.data?.timeZone;

  return (
    <>
      {!routine && (
        <InlinePicker
          label={t('appAdmin.routines.bot')}
          options={bots.map((b) => ({ value: b.id, label: b.name }))}
          value={botId}
          placeholder={t('appAdmin.routines.chooseBot')}
          onChange={setBotId}
        />
      )}
      <Field
        label={t('appAdmin.routines.name')}
        value={name}
        onChangeText={setName}
        placeholder={t('appAdmin.routines.namePlaceholder')}
        maxLength={100}
      />
      <Field
        label={t('appAdmin.routines.instruction')}
        value={prompt}
        onChangeText={setPrompt}
        placeholder={t('appAdmin.routines.instructionPlaceholder')}
        multiline
        maxLength={4000}
        textAlignVertical="top"
        style={styles.multiline}
      />

      <Section title={t('appAdmin.routines.when')}>
        <ListCard inset={ROW_INSET}>
          <ChoiceRows<TriggerType>
            options={TRIGGER_TYPES.map((type) => ({
              value: type,
              label: t(`appAdmin.routines.types.${type}`),
            }))}
            value={draft.type}
            onChange={(type) => patch({ type })}
          />
        </ListCard>
        {draft.type === 'cron' && (
          <Field
            label={t('appAdmin.routines.cronLabel')}
            value={draft.cron}
            onChangeText={(cron) => patch({ cron })}
            hint={cronPreview ?? t('appAdmin.routines.cronHint')}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            maxLength={100}
            style={styles.mono}
          />
        )}
        {draft.type === 'interval' && (
          <Field
            label={t('appAdmin.routines.minutes')}
            value={draft.minutes}
            onChangeText={(minutes) => patch({ minutes })}
            hint={t('appAdmin.routines.minutesHint')}
            keyboardType="number-pad"
            maxLength={5}
          />
        )}
        {draft.type === 'once' && (
          <View style={styles.pair}>
            <View style={styles.day}>
              <Field
                label={t('appAdmin.routines.day')}
                value={draft.day}
                onChangeText={(day) => patch({ day })}
                placeholder={t('appAdmin.routines.dayPlaceholder')}
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                maxLength={10}
              />
            </View>
            <View style={styles.time}>
              <Field
                label={t('appAdmin.routines.time')}
                value={draft.time}
                onChangeText={(time) => patch({ time })}
                placeholder={t('appAdmin.routines.timePlaceholder')}
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                maxLength={5}
              />
            </View>
          </View>
        )}
        {draft.type === 'webhook' && !routine?.webhookUrl && (
          <Note>{t('appAdmin.routines.webhookTypeHint')}</Note>
        )}
        {(draft.type === 'cron' || draft.type === 'interval') && zone ? (
          <Caption>{t('appAdmin.proactivity.timeZone', { zone })}</Caption>
        ) : null}
      </Section>

      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('appAdmin.routines.notify')}
          hint={t('appAdmin.routines.notifyHint')}
          value={notify}
          onChange={setNotify}
        />
      </ListCard>

      <FormError message={error} />
      <FormActions>
        <Button
          label={
            routine
              ? t('common.save')
              : pending
                ? t('appAdmin.routines.creating')
                : t('appAdmin.routines.create')
          }
          onPress={submit}
          loading={pending}
          disabled={!dirty}
        />
      </FormActions>
    </>
  );
}

const styles = StyleSheet.create({
  multiline: { minHeight: 120, paddingTop: 14, paddingBottom: 14 },
  mono: { fontFamily: fonts.mono, fontSize: 14 },
  pair: { flexDirection: 'row', gap: 8 },
  day: { flex: 3, minWidth: 0 },
  time: { flex: 2, minWidth: 0 },
});
