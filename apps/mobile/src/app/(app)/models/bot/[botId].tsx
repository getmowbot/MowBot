import type { Bot, Provider } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ModelChoice, ModelRefInput } from '../../../../components/admin/model-ref-input';
import { FormError, Loading, Note } from '../../../../components/admin/parts';
import { FormActions, Screen } from '../../../../components/screen';
import { Button } from '../../../../components/ui/button';
import { adminError, useUpdateBotSettings } from '../../../../lib/admin-queries';
import { useBots, useProviders } from '../../../../lib/queries';

function BotModelForm({ bot, providers }: { bot: Bot; providers: Provider[] }) {
  const { t } = useTranslation();
  const update = useUpdateBotSettings(bot.id);
  const [choice, setChoice] = useState<ModelChoice>({
    providerId: bot.providerId,
    model: bot.model ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const provider = providers.find((p) => p.id === choice.providerId);
  const model = choice.model.trim() || null;
  const dirty =
    choice.providerId !== bot.providerId || (choice.providerId !== null && model !== bot.model);

  const save = () => {
    if (provider && !model && !provider.defaultModel) {
      setError(t('appAdmin.models.modelRequired'));
      return;
    }
    setError(null);
    update.mutate(provider ? { providerId: provider.id, model } : { providerId: null }, {
      onSuccess: () => router.back(),
      onError: (err) => setError(adminError(err, t('appAdmin.models.changesNotSaved'))),
    });
  };

  return (
    <>
      <Note>{t('appAdmin.models.botModelHint', { name: bot.name })}</Note>
      <ModelRefInput
        providers={providers}
        value={choice}
        onChange={setChoice}
        noneLabel={t('appAdmin.models.noProvider')}
        hint={
          provider?.defaultModel
            ? t('appAdmin.models.defaultModelHint', { model: provider.defaultModel })
            : undefined
        }
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

/** Which provider and model a bot thinks with (the web's "each bot's model"). */
export default function BotModelScreen() {
  const { t } = useTranslation();
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const bots = useBots();
  const providers = useProviders();
  const bot = bots.data?.find((b) => b.id === botId);

  return (
    <Screen
      title={bot ? t('appAdmin.models.modelOf', { name: bot.name }) : t('appAdmin.models.model')}
    >
      {bots.isPending || providers.isPending ? (
        <Loading />
      ) : bot ? (
        <BotModelForm key={bot.id} bot={bot} providers={providers.data ?? []} />
      ) : (
        <Note>{t('common.botNotFound')}</Note>
      )}
    </Screen>
  );
}
