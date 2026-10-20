import { PROVIDER_DEFAULT_URLS, type ProviderKind } from '@mowbot/contract';
import { router } from 'expo-router';
import { Plug } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';
import { HeadersEditor } from '../../../components/admin/headers-editor';
import { FormError } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { FormActions, Screen } from '../../../components/screen';
import { Section } from '../../../components/tab-scroll';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ChoiceRows, ROW_INSET } from '../../../components/ui/rows';
import { adminError, useCreateProvider } from '../../../lib/admin-queries';
import {
  type HeaderRow,
  headersRecord,
  kindHint,
  kindLabel,
  PROVIDER_KINDS,
  providerFormProblem,
} from '../../../lib/provider-form';
import { fonts } from '../../../theme';

/** Connects a provider: Command Code, OpenAI or any OpenAI-compatible endpoint. */
export default function NewProviderScreen() {
  const { t } = useTranslation();
  const create = useCreateProvider();
  const [kind, setKind] = useState<ProviderKind>('command-code');
  // null: not typed yet, follows the kind ("Command Code", "OpenAI"…).
  const [name, setName] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nameValue = name ?? kindLabel(kind, t);

  const submit = () => {
    const problem = providerFormProblem({
      kind,
      name: nameValue,
      baseUrl,
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
          <ChoiceRows<ProviderKind>
            options={PROVIDER_KINDS.map((option) => ({
              value: option.kind,
              label: kindLabel(option.kind, t),
              hint: kindHint(option.kind, t),
            }))}
            value={kind}
            onChange={setKind}
          />
        </ListCard>
      </Section>

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
        placeholder={t('appAdmin.models.apiKeyPlaceholder')}
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
        placeholder={PROVIDER_DEFAULT_URLS[kind] ?? 'https://openrouter.ai/api/v1'}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.mono}
      />
      <Field
        label={t('appAdmin.models.defaultModel')}
        value={defaultModel}
        onChangeText={setDefaultModel}
        placeholder={t('appAdmin.models.defaultModelPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
      />

      <HeadersEditor kind={kind} rows={rows} onChange={setRows} />

      <FormError message={error} />
      <FormActions>
        <Button
          label={create.isPending ? t('appAdmin.models.connecting') : t('appAdmin.models.connect')}
          icon={Plug}
          onPress={submit}
          loading={create.isPending}
          disabled={!nameValue.trim()}
        />
      </FormActions>
    </Screen>
  );
}

const styles = StyleSheet.create({
  mono: { fontFamily: fonts.mono, fontSize: 14 },
});
