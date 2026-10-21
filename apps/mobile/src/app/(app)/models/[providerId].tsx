import { type Bot, CHATGPT_USAGE_URL, type Provider } from '@mowbot/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { CircleAlert, CircleCheck, ExternalLink, RefreshCw, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Linking, StyleSheet } from 'react-native';
import { HeadersEditor } from '../../../components/admin/headers-editor';
import { FormError, Loading, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ICON_ROW_INSET, ListRow, ROW_INSET } from '../../../components/ui/rows';
import {
  adminError,
  problemDetail,
  useDeleteProvider,
  useProviderModels,
  useUpdateProvider,
} from '../../../lib/admin-queries';
import { alertError, confirm } from '../../../lib/options-menu';
import {
  headerRows,
  headersRecord,
  isChatgpt,
  kindLabel,
  providerFormProblem,
  sameHeaders,
} from '../../../lib/provider-form';
import { useBots, useProviders } from '../../../lib/queries';
import { colors, fonts } from '../../../theme';

const MODELS_SHOWN = 8;

/** Whether the endpoint answers (its model list doubles as a connection test). */
function Connection({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const models = useProviderModels(provider.id);
  const label = models.isSuccess
    ? t('appAdmin.models.available', { count: models.data.length })
    : models.isError
      ? t('appAdmin.models.unreachable')
      : t('appAdmin.models.testing');
  return (
    <Section title={t('appAdmin.models.connection')}>
      <ListCard inset={ICON_ROW_INSET}>
        <ListRow
          icon={models.isError ? CircleAlert : CircleCheck}
          label={label}
          hint={[kindLabel(provider.kind, t), problemDetail(models.error)]
            .filter(Boolean)
            .join(' · ')}
          accessory={
            models.isFetching ? <ActivityIndicator size="small" color={colors.textMuted} /> : null
          }
        />
        <ListRow
          icon={RefreshCw}
          label={t('appAdmin.models.retest')}
          chevron={false}
          disabled={models.isFetching}
          onPress={() => void models.refetch()}
        />
      </ListCard>
    </Section>
  );
}

function ModelList({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const models = useProviderModels(providerId);
  const [all, setAll] = useState(false);
  const ids = models.data ?? [];
  if (ids.length === 0) return null;
  const shown = all ? ids : ids.slice(0, MODELS_SHOWN);
  return (
    <Section title={t('appAdmin.models.models')}>
      <ListCard inset={ROW_INSET}>
        {shown.map((id) => (
          <ListRow key={id} label={id} />
        ))}
        {ids.length > MODELS_SHOWN && (
          <ListRow
            key="more"
            label={
              all
                ? t('appAdmin.models.showLess')
                : t('appAdmin.models.showAll', { count: ids.length })
            }
            chevron={false}
            onPress={() => setAll((value) => !value)}
          />
        )}
      </ListCard>
    </Section>
  );
}

interface Usage {
  bot: Bot;
  value: string;
  hint: string | undefined;
  href: string;
}

/** Bots that rely on this provider, for their own model, check-ins or as a fallback. */
function UsedBy({ provider, bots }: { provider: Provider; bots: Bot[] }) {
  const { t } = useTranslation();
  const rows = bots.flatMap((bot): Usage[] => {
    if (bot.providerId === provider.id) {
      return [
        {
          bot,
          value: bot.model ?? provider.defaultModel ?? '—',
          hint: undefined,
          href: `/bot/${bot.id}`,
        },
      ];
    }
    const light = bot.lightModel?.providerId === provider.id ? bot.lightModel : null;
    const fallback = bot.fallbacks.find((ref) => ref.providerId === provider.id);
    const ref = light ?? fallback;
    if (!ref) return [];
    return [
      {
        bot,
        value: ref.model,
        hint: light ? t('appAdmin.proactivity.lightModel') : t('appAdmin.proactivity.fallback'),
        href: `/bot/${bot.id}`,
      },
    ];
  });
  return (
    <Section title={t('appAdmin.models.usedBy')}>
      {rows.length === 0 ? (
        <Note>{t('appAdmin.models.usedByNone')}</Note>
      ) : (
        <ListCard inset={ROW_INSET}>
          {rows.map((row) => (
            <ListRow
              key={row.bot.id}
              label={row.bot.name}
              hint={row.hint}
              value={row.value}
              onPress={() => router.push(row.href)}
            />
          ))}
        </ListCard>
      )}
    </Section>
  );
}

/** The ChatGPT account of an `openai-chatgpt` provider (signed in from the desktop app). */
function ChatgptAccount({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const account = provider.chatgpt;
  if (!account) return null;
  const state =
    account.status === 'needs_sign_in'
      ? t('appAdmin.models.chatgpt.needsSignIn')
      : account.status === 'usage_limited'
        ? t('appAdmin.models.chatgpt.limited')
        : t('appAdmin.models.chatgpt.connected');
  const plan = account.planType
    ? t('appAdmin.models.chatgpt.plan', {
        plan: account.planType.charAt(0).toUpperCase() + account.planType.slice(1),
      })
    : null;
  return (
    <Section title={t('appAdmin.models.chatgpt.account')}>
      <ListCard inset={ICON_ROW_INSET}>
        <ListRow
          icon={account.status === 'connected' ? CircleCheck : CircleAlert}
          label={account.email ?? '—'}
          hint={[plan, state].filter(Boolean).join(' · ')}
        />
        <ListRow
          icon={ExternalLink}
          label={t('appAdmin.models.chatgpt.manageUsage')}
          chevron={false}
          onPress={() =>
            void Linking.openURL(CHATGPT_USAGE_URL).catch(() =>
              alertError(t('common.actionFailed')),
            )
          }
        />
      </ListCard>
      {account.status === 'needs_sign_in' && (
        <Note>{t('appAdmin.models.chatgpt.needsSignInHint')}</Note>
      )}
      {account.status === 'usage_limited' && (
        <Note>{t('appAdmin.models.chatgpt.limitedHint')}</Note>
      )}
    </Section>
  );
}

function ProviderDetail({ provider, bots }: { provider: Provider; bots: Bot[] }) {
  const { t } = useTranslation();
  const chatgpt = isChatgpt(provider.kind);
  const update = useUpdateProvider(provider.id);
  const remove = useDeleteProvider();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? '');
  const [rows, setRows] = useState(() => headerRows(provider.headers));
  const [error, setError] = useState<string | null>(null);

  const headers = headersRecord(rows);
  const nextDefault = defaultModel.trim() || null;
  const changes = {
    name: name.trim() !== provider.name,
    baseUrl: baseUrl.trim() !== provider.baseUrl,
    apiKey: apiKey.trim() !== '',
    defaultModel: nextDefault !== provider.defaultModel,
    headers: !sameHeaders(headers, provider.headers),
  };
  const dirty = Object.values(changes).some(Boolean);

  const save = () => {
    const problem = providerFormProblem({
      kind: provider.kind,
      name,
      baseUrl,
      rows,
      editing: true,
    });
    if (problem) {
      setError(t(`appAdmin.models.problems.${problem}`));
      return;
    }
    setError(null);
    update.mutate(
      {
        ...(changes.name ? { name: name.trim() } : {}),
        ...(changes.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
        // Write-only: sent when typed, never shown back.
        ...(changes.apiKey ? { apiKey: apiKey.trim() } : {}),
        ...(changes.defaultModel ? { defaultModel: nextDefault } : {}),
        ...(changes.headers ? { headers } : {}),
      },
      {
        onSuccess: (saved) => {
          setName(saved.name);
          setBaseUrl(saved.baseUrl);
          setApiKey('');
          setDefaultModel(saved.defaultModel ?? '');
          setRows(headerRows(saved.headers));
        },
        onError: (err) => setError(adminError(err, t('appAdmin.models.changesNotSaved'))),
      },
    );
  };

  const askDelete = async () => {
    const ok = await confirm(
      t('appAdmin.models.confirmDelete', { name: provider.name }),
      t('appAdmin.models.deleteHint'),
      { label: t('common.delete'), destructive: true },
    );
    if (!ok) return;
    remove.mutate(provider.id, {
      onSuccess: () => router.back(),
      onError: (err) => alertError(adminError(err, t('common.actionFailed'))),
    });
  };

  return (
    <>
      <Connection provider={provider} />
      <ChatgptAccount provider={provider} />

      <Field
        label={t('appAdmin.models.name')}
        value={name}
        onChangeText={setName}
        maxLength={60}
        autoCorrect={false}
      />
      {/* A ChatGPT provider has no key, URL or headers: OpenAI's, with the account's tokens. */}
      {!chatgpt && (
        <>
          <Field
            label={t('appAdmin.models.apiKey')}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={
              provider.hasApiKey
                ? t('appAdmin.models.apiKeyUnchanged')
                : t('appAdmin.models.apiKeyNone')
            }
            hint={provider.hasApiKey ? t('appAdmin.models.apiKeyKeepHint') : undefined}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            textContentType="none"
            importantForAutofill="no"
            maxLength={1000}
          />
          <Field
            label={t('appAdmin.models.baseUrl')}
            value={baseUrl}
            onChangeText={setBaseUrl}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.mono}
          />
        </>
      )}
      <Field
        label={t('appAdmin.models.defaultModel')}
        value={defaultModel}
        onChangeText={setDefaultModel}
        placeholder={t('appAdmin.models.defaultModelPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
      />
      {!chatgpt && <HeadersEditor kind={provider.kind} rows={rows} onChange={setRows} />}

      <FormError message={error} />
      <FormActions>
        <Button
          label={t('common.save')}
          onPress={save}
          loading={update.isPending}
          disabled={!dirty}
        />
      </FormActions>

      <ModelList providerId={provider.id} />
      <UsedBy provider={provider} bots={bots} />

      <FormActions>
        <Button
          label={t('appAdmin.models.delete')}
          icon={Trash2}
          variant="danger"
          loading={remove.isPending}
          onPress={() => void askDelete()}
        />
      </FormActions>
    </>
  );
}

/** One provider: connection test, settings, its models and the bots that use it. */
export default function ProviderScreen() {
  const { t } = useTranslation();
  const { providerId } = useLocalSearchParams<{ providerId: string }>();
  const providers = useProviders();
  const bots = useBots();
  const provider = providers.data?.find((p) => p.id === providerId);

  return (
    <Screen
      title={provider?.name ?? t('appAdmin.models.title')}
      onRefresh={() => Promise.all([providers.refetch(), bots.refetch()])}
    >
      {providers.isPending ? (
        <Loading />
      ) : provider ? (
        <ProviderDetail key={provider.id} provider={provider} bots={bots.data ?? []} />
      ) : (
        <Note>{t('appAdmin.models.notFound')}</Note>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  mono: { fontFamily: fonts.mono, fontSize: 14 },
});
