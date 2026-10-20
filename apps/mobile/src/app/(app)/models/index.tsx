import type { Bot, Provider } from '@mowbot/contract';
import { router } from 'expo-router';
import { KeyRound, Plug, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';
import { LoadError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button, IconButton } from '../../../components/ui/button';
import { ICON_ROW_INSET, ListRow, ROW_INSET } from '../../../components/ui/rows';
import { T } from '../../../components/ui/text';
import { useProviderModels } from '../../../lib/admin-queries';
import { kindLabel, urlLabel } from '../../../lib/provider-form';
import { useBots, useProviders } from '../../../lib/queries';
import { colors } from '../../../theme';

/** How a provider answers: its model count, unreachable, or still testing. */
function ConnectionBadge({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const models = useProviderModels(providerId);
  if (models.isSuccess) {
    return (
      <T variant="callout" tone="muted" numberOfLines={1}>
        {t('appAdmin.models.modelCount', { count: models.data.length })}
      </T>
    );
  }
  if (models.isError) {
    return (
      <T variant="callout" tone="danger" numberOfLines={1}>
        {t('appAdmin.models.unreachable')}
      </T>
    );
  }
  return (
    <ActivityIndicator
      size="small"
      color={colors.textMuted}
      accessibilityLabel={t('appAdmin.models.testing')}
    />
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const headerCount = Object.keys(provider.headers).length;
  const hint = [
    kindLabel(provider.kind, t),
    urlLabel(provider.baseUrl),
    headerCount > 0 ? t('appAdmin.models.headerCount', { count: headerCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <ListRow
      icon={KeyRound}
      label={provider.name}
      hint={hint}
      accessory={<ConnectionBadge providerId={provider.id} />}
      onPress={() => router.push(`/models/${provider.id}`)}
    />
  );
}

function BotModelRow({ bot, providers }: { bot: Bot; providers: Provider[] }) {
  const { t } = useTranslation();
  const provider = providers.find((p) => p.id === bot.providerId);
  const model = bot.model ?? provider?.defaultModel ?? null;
  return (
    <ListRow
      label={bot.name}
      hint={provider?.name}
      value={provider ? (model ?? '—') : t('appAdmin.models.noModel')}
      onPress={() => router.push(`/models/bot/${bot.id}`)}
    />
  );
}

/** LLM providers (keys, URLs, headers) and which model each bot uses. */
export default function ModelsScreen() {
  const { t } = useTranslation();
  const providers = useProviders();
  const bots = useBots();
  const list = providers.data ?? [];
  const sortedBots = [...(bots.data ?? [])].sort((a, b) => Number(b.isChef) - Number(a.isChef));
  const add = () => router.push('/models/new');

  return (
    <Screen
      title={t('appAdmin.models.title')}
      headerRight={() => <IconButton icon={Plus} label={t('appAdmin.models.add')} onPress={add} />}
      onRefresh={() => Promise.all([providers.refetch(), bots.refetch()])}
    >
      <Note>{t('appAdmin.models.subtitle')}</Note>
      {providers.isPending ? (
        <Loading />
      ) : providers.isError ? (
        <LoadError onRetry={() => void providers.refetch()} />
      ) : (
        <Section title={t('appAdmin.models.providers')}>
          {list.length === 0 ? (
            <>
              <Note>{t('appAdmin.models.empty')}</Note>
              <Button label={t('appAdmin.models.add')} icon={Plug} onPress={add} />
            </>
          ) : (
            <ListCard inset={ICON_ROW_INSET}>
              {list.map((provider) => (
                <ProviderRow key={provider.id} provider={provider} />
              ))}
            </ListCard>
          )}
        </Section>
      )}
      {list.length > 0 && sortedBots.length > 0 && (
        <Section title={t('appAdmin.models.perBot')}>
          <ListCard inset={ROW_INSET}>
            {sortedBots.map((bot) => (
              <BotModelRow key={bot.id} bot={bot} providers={list} />
            ))}
          </ListCard>
        </Section>
      )}
    </Screen>
  );
}
