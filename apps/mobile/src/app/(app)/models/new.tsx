import {
  ANTHROPIC_DEFAULT_MODEL,
  PROVIDER_DEFAULT_URLS,
  type ProviderKind,
} from '@mowbot/contract';
import { router } from 'expo-router';
import { Download, Plug } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet } from 'react-native';
import { HeadersEditor } from '../../../components/admin/headers-editor';
import { FormError, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { ProviderMark } from '../../../components/provider-mark';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, ROW_INSET } from '../../../components/ui/rows';
import { adminError, useCreateProvider } from '../../../lib/admin-queries';
import { alertError } from '../../../lib/options-menu';
import {
  DESKTOP_DOWNLOAD_URL,
  type HeaderRow,
  headersRecord,
  isChatgpt,
  keyRequired,
  providerFormProblem,
  providerOptions,
} from '../../../lib/provider-form';
import { fonts } from '../../../theme';

/**
 * Connects a provider: Anthropic, OpenAI, Command Code, a well-known service (OpenRouter, Gemini…)
 * or any OpenAI-compatible endpoint. A ChatGPT account is signed in from the desktop app.
 */
export default function NewProviderScreen() {
  const { t } = useTranslation();
  const create = useCreateProvider();
  const options = providerOptions(t);
  const [picked, setPicked] = useState<string | null>(null);
  const option = options.find((candidate) => candidate.id === picked);
  const kind: ProviderKind = option?.kind ?? 'openai-compatible';
  // null: not typed yet, follows the choice ("Anthropic", "OpenRouter"…).
  const [name, setName] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nameValue = name ?? option?.name ?? '';
  const needsKey = option ? keyRequired(option) : false;

  // Another choice: its name and its address (a preset's) start over.
  const pick = (id: string) => {
    const next = options.find((candidate) => candidate.id === id);
    setPicked(id);
    setName(null);
    setBaseUrl(next?.baseUrl ?? '');
    setError(null);
  };

  const submit = () => {
    if (!option) return;
    const problem = providerFormProblem({
      kind,
      name: nameValue,
      baseUrl,
      apiKey,
      needsKey,
      rows,
      editing: false,
    });
    if (problem) {
      setError(t(`appAdmin.models.problems.${problem}`));
      return;
    }
    setError(null);
    create.mutate(
      {
        kind,
        name: nameValue.trim(),
        baseUrl: baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        defaultModel: defaultModel.trim() || undefined,
        headers: headersRecord(rows),
      },
      {
        // On to its page, where the connection test shows.
        onSuccess: (provider) => router.replace(`/models/${provider.id}`),
        onError: (err) => setError(adminError(err, t('appAdmin.models.addFailed'))),
      },
    );
  };

  return (
    <Screen title={t('appAdmin.models.newTitle')}>
      <Section title={t('appAdmin.models.kind')}>
        <ListCard inset={ROW_INSET}>
          <ChoiceRows<string>
            options={options.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
              hint: candidate.id === picked ? candidate.hint : undefined,
              icon: <ProviderMark kind={candidate.kind} baseUrl={candidate.baseUrl} />,
            }))}
            value={picked}
            onChange={pick}
          />
        </ListCard>
      </Section>

      {!option ? null : isChatgpt(kind) ? (
        <ChatgptFromDesktop />
      ) : (
        <KeyFields
          kind={kind}
          needsKey={needsKey}
          nameValue={nameValue}
          setName={setName}
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          apiKey={apiKey}
          setApiKey={setApiKey}
          defaultModel={defaultModel}
          setDefaultModel={setDefaultModel}
          rows={rows}
          setRows={setRows}
          error={error}
          pending={create.isPending}
          onSubmit={submit}
        />
      )}
    </Screen>
  );
}

/** ChatGPT accounts are signed in from the desktop app (the sign-in comes back to its computer). */
function ChatgptFromDesktop() {
  const { t } = useTranslation();
  return (
    <>
      <Note>{t('appAdmin.models.chatgpt.desktopOnly')}</Note>
      <FormActions>
        <Button
          label={t('appAdmin.models.chatgpt.download')}
          icon={Download}
          variant="secondary"
          onPress={() =>
            void Linking.openURL(DESKTOP_DOWNLOAD_URL).catch(() =>
              alertError(t('common.actionFailed')),
            )
          }
        />
      </FormActions>
    </>
  );
}

interface KeyFieldsProps {
  kind: ProviderKind;
  needsKey: boolean;
  nameValue: string;
  setName(value: string): void;
  baseUrl: string;
  setBaseUrl(value: string): void;
  apiKey: string;
  setApiKey(value: string): void;
  defaultModel: string;
  setDefaultModel(value: string): void;
  rows: HeaderRow[];
  setRows(rows: HeaderRow[]): void;
  error: string | null;
  pending: boolean;
  onSubmit(): void;
}

/** The fields of a provider reached with an API key. */
function KeyFields({
  kind,
  needsKey,
  nameValue,
  setName,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  defaultModel,
  setDefaultModel,
  rows,
  setRows,
  error,
  pending,
  onSubmit,
}: KeyFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t('appAdmin.models.name')}
        value={nameValue}
        onChangeText={setName}
        maxLength={60}
        autoCorrect={false}
      />
      <Field
        label={t('appAdmin.models.apiKey')}
        value={apiKey}
        onChangeText={setApiKey}
        placeholder={
          kind === 'anthropic'
            ? 'sk-ant-…'
            : needsKey
              ? t('appAdmin.models.apiKeyPlaceholder')
              : t('appAdmin.models.apiKeyOptional')
        }
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
        placeholder={PROVIDER_DEFAULT_URLS[kind] ?? 'https://api.example.com/v1'}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.mono}
      />
      <Field
        label={t('appAdmin.models.defaultModel')}
        value={defaultModel}
        onChangeText={setDefaultModel}
        placeholder={
          kind === 'anthropic'
            ? ANTHROPIC_DEFAULT_MODEL
            : t('appAdmin.models.defaultModelPlaceholder')
        }
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
      />

      <HeadersEditor kind={kind} rows={rows} onChange={setRows} />

      <FormError message={error} />
      <FormActions>
        <Button
          label={pending ? t('appAdmin.models.connecting') : t('appAdmin.models.connect')}
          icon={Plug}
          onPress={onSubmit}
          loading={pending}
          disabled={!nameValue.trim()}
        />
      </FormActions>
    </>
  );
}

const styles = StyleSheet.create({
  mono: { fontFamily: fonts.mono, fontSize: 14 },
});
