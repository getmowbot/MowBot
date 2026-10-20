import type { Bot, SystemSettings } from '@mowbot/contract';
import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Caption, FormError, LoadError, Loading, Note } from '../../components/admin/parts';
import { ListCard } from '../../components/list-card';
import { FormActions, Screen } from '../../components/screen';
import { Section } from '../../components/tab-scroll';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { ListRow, ROW_INSET, SwitchRow } from '../../components/ui/rows';
import { adminError, useSystem, useUpdateSystem } from '../../lib/admin-queries';
import { alertError, confirm } from '../../lib/options-menu';
import { heartbeatLabel } from '../../lib/org-forms';
import { checkBudget, checkQuietHours, formatTokens } from '../../lib/proactivity-form';
import { useBots } from '../../lib/queries';

interface Draft {
  quiet: boolean;
  start: string;
  end: string;
  budget: string;
}

const draftOf = (settings: SystemSettings): Draft => ({
  quiet: Boolean(settings.quietHours),
  start: settings.quietHours?.start ?? '22:00',
  end: settings.quietHours?.end ?? '07:00',
  budget: settings.dailyTokenBudget ? String(settings.dailyTokenBudget) : '',
});

const sameDraft = (a: Draft, b: Draft) =>
  a.quiet === b.quiet &&
  a.budget.trim() === b.budget.trim() &&
  (!a.quiet || (a.start.trim() === b.start && a.end.trim() === b.end));

function PauseSwitch({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const update = useUpdateSystem();
  const paused = update.isPending ? (update.variables.paused ?? settings.paused) : settings.paused;

  const toggle = async (next: boolean) => {
    if (
      next &&
      !(await confirm(t('appAdmin.proactivity.pause'), t('appAdmin.proactivity.confirmPause'), {
        label: t('appAdmin.proactivity.pauseAction'),
        destructive: true,
      }))
    ) {
      return;
    }
    update.mutate(
      { paused: next },
      { onError: (err) => alertError(adminError(err, t('appAdmin.proactivity.notSaved'))) },
    );
  };

  return (
    <ListCard inset={ROW_INSET}>
      <SwitchRow
        label={t('appAdmin.proactivity.pause')}
        hint={t('appAdmin.proactivity.pauseHint')}
        value={paused}
        onChange={(next) => void toggle(next)}
      />
    </ListCard>
  );
}

/** Quiet hours and the daily budget of all bots together. */
function GlobalSettings({ settings }: { settings: SystemSettings }) {
  const { t } = useTranslation();
  const update = useUpdateSystem();
  // null: untouched, follows the hub (another device may change it meanwhile).
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saved = draftOf(settings);
  const form = draft ?? saved;
  const dirty = draft !== null && !sameDraft(draft, saved);
  const patch = (next: Partial<Draft>) => setDraft({ ...form, ...next });

  const save = () => {
    const quiet = checkQuietHours({ enabled: form.quiet, start: form.start, end: form.end });
    if (!quiet.ok) {
      setError(t(`appAdmin.proactivity.problems.${quiet.problem}`));
      return;
    }
    const budget = checkBudget(form.budget);
    if (!budget.ok) {
      setError(t('appAdmin.proactivity.problems.budget'));
      return;
    }
    setError(null);
    update.mutate(
      { quietHours: quiet.value, dailyTokenBudget: budget.value },
      {
        onSuccess: () => setDraft(null),
        onError: (err) => setError(adminError(err, t('appAdmin.proactivity.notSaved'))),
      },
    );
  };

  return (
    <>
      <Section title={t('appAdmin.proactivity.quietHours')}>
        <ListCard inset={ROW_INSET}>
          <SwitchRow
            label={t('appAdmin.proactivity.quietHours')}
            hint={t('appAdmin.proactivity.quietHoursHint')}
            value={form.quiet}
            onChange={(quiet) => patch({ quiet })}
          />
        </ListCard>
        {form.quiet && (
          <View style={styles.pair}>
            <View style={styles.half}>
              <Field
                label={t('appAdmin.proactivity.quietStart')}
                value={form.start}
                onChangeText={(start) => patch({ start })}
                placeholder="22:00"
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                maxLength={5}
              />
            </View>
            <View style={styles.half}>
              <Field
                label={t('appAdmin.proactivity.quietEnd')}
                value={form.end}
                onChangeText={(end) => patch({ end })}
                placeholder="07:00"
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                maxLength={5}
              />
            </View>
          </View>
        )}
        <Caption>{t('appAdmin.proactivity.timeZone', { zone: settings.timeZone })}</Caption>
      </Section>

      <Field
        label={t('appAdmin.proactivity.globalBudget')}
        value={form.budget}
        onChangeText={(budget) => patch({ budget })}
        placeholder={t('appAdmin.proactivity.noLimit')}
        hint={t('appAdmin.proactivity.budgetHint')}
        keyboardType="number-pad"
        maxLength={12}
      />

      <FormError message={error} />
      <FormActions>
        <Button
          label={t('common.save')}
          onPress={save}
          loading={update.isPending}
          disabled={!dirty}
        />
      </FormActions>
    </>
  );
}

function BotRow({ bot }: { bot: Bot }) {
  const { t, i18n } = useTranslation();
  const hint = [
    heartbeatLabel(bot.heartbeatMinutes, t),
    bot.dailyTokenBudget
      ? t('appAdmin.proactivity.perDay', {
          value: formatTokens(bot.dailyTokenBudget, i18n.language),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return <ListRow label={bot.name} hint={hint} onPress={() => router.push(`/bot/${bot.id}`)} />;
}

/** How much bots act on their own: the kill switch, quiet hours, budgets, then each bot. */
export default function ProactivityScreen() {
  const { t } = useTranslation();
  const system = useSystem();
  const bots = useBots();
  const sorted = [...(bots.data ?? [])].sort((a, b) => Number(b.isChef) - Number(a.isChef));

  return (
    <Screen
      title={t('appAdmin.proactivity.title')}
      onRefresh={() => Promise.all([system.refetch(), bots.refetch()])}
    >
      <Note>{t('appAdmin.proactivity.subtitle')}</Note>
      {system.isPending ? (
        <Loading />
      ) : system.isError ? (
        <LoadError onRetry={() => void system.refetch()} />
      ) : (
        <>
          <PauseSwitch settings={system.data} />
          <GlobalSettings settings={system.data} />
        </>
      )}
      {sorted.length > 0 && (
        <Section title={t('appAdmin.proactivity.perBot')}>
          <ListCard inset={ROW_INSET}>
            {sorted.map((bot) => (
              <BotRow key={bot.id} bot={bot} />
            ))}
          </ListCard>
        </Section>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 8 },
  half: { flex: 1, minWidth: 0 },
});
