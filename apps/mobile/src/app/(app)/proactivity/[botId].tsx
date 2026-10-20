import type { Bot, BotUpdate, ModelRef, Provider } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarClock } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ModelChoice, ModelRefInput } from '../../../components/admin/model-ref-input';
import { FormError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, ICON_ROW_INSET, ListRow, ROW_INSET } from '../../../components/ui/rows';
import { adminError, useUpdateBotSettings } from '../../../lib/admin-queries';
import {
  checkBudget,
  checkModelRef,
  heartbeatChoices,
  heartbeatLabel,
  sameModelRef,
} from '../../../lib/proactivity-form';
import { useBots, useProviders } from '../../../lib/queries';

const choiceOf = (ref: ModelRef | null | undefined): ModelChoice => ({
  providerId: ref?.providerId ?? null,
  model: ref?.model ?? '',
});

/** Heartbeat values as ChoiceRows values ('off' for none). */
const heartbeatValue = (minutes: number | null) => (minutes === null ? 'off' : String(minutes));

function BotProactivity({ bot, providers }: { bot: Bot; providers: Provider[] }) {
  const { t } = useTranslation();
  const update = useUpdateBotSettings(bot.id);
  const [heartbeat, setHeartbeat] = useState(bot.heartbeatMinutes);
  const [budget, setBudget] = useState(bot.dailyTokenBudget ? String(bot.dailyTokenBudget) : '');
  const [light, setLight] = useState(() => choiceOf(bot.lightModel));
  const [fallback, setFallback] = useState(() => choiceOf(bot.fallbacks[0]));
  const [error, setError] = useState<string | null>(null);

  const checkedBudget = checkBudget(budget);
  const checkedLight = checkModelRef(light.providerId, light.model);
  const checkedFallback = checkModelRef(fallback.providerId, fallback.model);
  // The web edits the first fallback only; the others (set by the Chef) are kept.
  const otherFallbacks = bot.fallbacks.slice(1);
  const changes = {
    heartbeat: heartbeat !== bot.heartbeatMinutes,
    budget: !checkedBudget.ok || checkedBudget.value !== bot.dailyTokenBudget,
    light: !checkedLight.ok || !sameModelRef(checkedLight.value, bot.lightModel),
    fallback: !checkedFallback.ok || !sameModelRef(checkedFallback.value, bot.fallbacks[0] ?? null),
  };
  const dirty = Object.values(changes).some(Boolean);

  const save = () => {
    if (!checkedBudget.ok) {
      setError(t('appAdmin.proactivity.problems.budget'));
      return;
    }
    if (!checkedLight.ok || !checkedFallback.ok) {
      setError(t('appAdmin.models.modelRequired'));
      return;
    }
    const body: BotUpdate = {
      ...(changes.heartbeat ? { heartbeatMinutes: heartbeat } : {}),
      ...(changes.budget ? { dailyTokenBudget: checkedBudget.value } : {}),
      ...(changes.light ? { lightModel: checkedLight.value } : {}),
      ...(changes.fallback
        ? {
            fallbacks: checkedFallback.value
              ? [checkedFallback.value, ...otherFallbacks]
              : otherFallbacks,
          }
        : {}),
    };
    setError(null);
    update.mutate(body, {
      onSuccess: () => router.back(),
      onError: (err) => setError(adminError(err, t('appAdmin.proactivity.notSaved'))),
    });
  };

  return (
    <>
      <Section title={t('appAdmin.proactivity.heartbeat')}>
        <ListCard inset={ROW_INSET}>
          <ChoiceRows
            options={heartbeatChoices(bot.heartbeatMinutes).map((minutes) => ({
              value: heartbeatValue(minutes),
              label: heartbeatLabel(minutes, t),
            }))}
            value={heartbeatValue(heartbeat)}
            onChange={(value) => setHeartbeat(value === 'off' ? null : Number(value))}
          />
        </ListCard>
      </Section>

      <Field
        label={t('appAdmin.proactivity.botBudget')}
        value={budget}
        onChangeText={setBudget}
        placeholder={t('appAdmin.proactivity.noLimit')}
        hint={t('appAdmin.proactivity.budgetHint')}
        keyboardType="number-pad"
        maxLength={12}
      />

      <Section title={t('appAdmin.proactivity.lightModel')}>
        <ModelRefInput
          providers={providers}
          value={light}
          onChange={setLight}
          noneLabel={t('appAdmin.settings.none')}
          hint={t('appAdmin.proactivity.lightModelHint')}
        />
      </Section>

      <Section title={t('appAdmin.proactivity.fallback')}>
        <ModelRefInput
          providers={providers}
          value={fallback}
          onChange={setFallback}
          noneLabel={t('appAdmin.settings.none')}
          hint={[
            t('appAdmin.proactivity.fallbackHint'),
            otherFallbacks.length > 0
              ? t('appAdmin.proactivity.moreFallbacks', { count: otherFallbacks.length })
              : null,
          ]
            .filter(Boolean)
            .join(' ')}
        />
      </Section>

      <FormError message={error} />
      <FormActions>
        <Button
          label={t('common.save')}
          onPress={save}
          loading={update.isPending}
          disabled={!dirty}
        />
      </FormActions>

      <ListCard inset={ICON_ROW_INSET}>
        <ListRow
          icon={CalendarClock}
          label={t('appAdmin.routines.title')}
          onPress={() => router.push(`/routines?bot=${bot.id}`)}
        />
      </ListCard>
    </>
  );
}

/** One bot's check-ins, budget, light and fallback models (the web's proactivity card). */
export default function BotProactivityScreen() {
  const { t } = useTranslation();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const bots = useBots();
  const providers = useProviders();
  const bot = bots.data?.find((b) => b.id === botId);

  return (
    <Screen title={bot?.name ?? t('appAdmin.proactivity.title')}>
      {bots.isPending || providers.isPending ? (
        <Loading />
      ) : bot ? (
        <BotProactivity key={bot.id} bot={bot} providers={providers.data ?? []} />
      ) : (
        <Note>{t('common.botNotFound')}</Note>
      )}
    </Screen>
  );
}
