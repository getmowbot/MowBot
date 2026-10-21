import { router, useLocalSearchParams } from 'expo-router';
import { Vault } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError, Note } from '../../../components/admin/parts';
import { ListCard } from '../../../components/list-card';
import { TextArea } from '../../../components/org/field-group';
import { FormActions, Screen } from '../../../components/screen';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { ROW_INSET, SwitchRow } from '../../../components/ui/rows';
import { Segmented } from '../../../components/ui/segmented';
import { SECRET_INPUT } from '../../../components/vault/parts';
import {
  createBody,
  EMPTY_LABELS,
  EMPTY_VALUES,
  type LabelDraft,
  newItemProblem,
  type ValueDraft,
} from '../../../lib/vault';
import { useCreateVaultItem, vaultError } from '../../../lib/vault-queries';

type Kind = 'login' | 'secret';

/** A login (username, password, 2FA seed) or a secret (API key, token), `?kind=` picks one. */
export default function NewVaultItemScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ kind?: string }>();
  const create = useCreateVaultItem();
  const [kind, setKind] = useState<Kind>(params.kind === 'secret' ? 'secret' : 'login');
  const [labels, setLabels] = useState<LabelDraft>(EMPTY_LABELS);
  const [values, setValues] = useState<ValueDraft>(EMPTY_VALUES);
  const [ask, setAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editLabels = (patch: Partial<LabelDraft>) => setLabels((draft) => ({ ...draft, ...patch }));
  const editValues = (patch: Partial<ValueDraft>) => setValues((draft) => ({ ...draft, ...patch }));

  const submit = () => {
    const problem = newItemProblem(kind, labels, values);
    if (problem) {
      setError(t(`vault.formProblems.${problem}`));
      return;
    }
    setError(null);
    create.mutate(createBody(kind, labels, values, ask ? 'ask' : 'auto'), {
      // On to its page, with the placeholders to use.
      onSuccess: (item) => router.replace(`/vault/${item.id}`),
      onError: (err) => setError(vaultError(err, t('vault.notCreated'))),
    });
  };

  return (
    <Screen title={kind === 'login' ? t('vault.newLogin') : t('vault.newSecret')}>
      <Segmented<Kind>
        label={t('vault.add')}
        options={[
          { value: 'login', label: t('vault.kinds.login') },
          { value: 'secret', label: t('vault.kinds.secret') },
        ]}
        value={kind}
        onChange={(next) => {
          setKind(next);
          setError(null);
        }}
      />
      <Note>{kind === 'login' ? t('vault.loginIntro') : t('vault.secretIntro')}</Note>

      <Field
        label={t('vault.labels.service')}
        value={labels.service}
        onChangeText={(service) => editLabels({ service })}
        placeholder={t('vault.labels.servicePlaceholder')}
        maxLength={100}
        autoCorrect={false}
      />
      <Field
        label={t('vault.labels.account')}
        value={labels.account}
        onChangeText={(account) => editLabels({ account })}
        placeholder={t('vault.labels.accountPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
      />
      <Field
        label={t('vault.labels.sites')}
        hint={t('vault.labels.sitesHint')}
        value={labels.sites}
        onChangeText={(sites) => editLabels({ sites })}
        placeholder={t('vault.labels.sitesPlaceholder')}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {kind === 'login' ? (
        <>
          <Field
            label={t('vault.values.username')}
            value={values.username}
            onChangeText={(username) => editValues({ username })}
            maxLength={500}
            {...SECRET_INPUT}
          />
          <Field
            label={t('vault.values.password')}
            value={values.password}
            onChangeText={(password) => editValues({ password })}
            placeholder={t('vault.values.newValue')}
            secureTextEntry
            maxLength={10_000}
            {...SECRET_INPUT}
          />
          <Field
            label={t('vault.values.totp')}
            hint={t('vault.values.totpHint')}
            value={values.totp}
            onChangeText={(totp) => editValues({ totp })}
            secureTextEntry
            maxLength={500}
            {...SECRET_INPUT}
          />
        </>
      ) : (
        <Field
          label={t('vault.values.value')}
          value={values.value}
          onChangeText={(value) => editValues({ value })}
          placeholder={t('vault.values.newValue')}
          secureTextEntry
          maxLength={10_000}
          {...SECRET_INPUT}
        />
      )}

      <TextArea
        label={t('vault.labels.notes')}
        hint={t('vault.labels.notesHint')}
        value={labels.notes}
        onChangeText={(notes) => editLabels({ notes })}
        placeholder={t('vault.labels.notesPlaceholder')}
        maxLength={2_000}
      />

      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('vault.policy.label')}
          hint={t('vault.policy.hint')}
          value={ask}
          onChange={setAsk}
        />
      </ListCard>

      <FormError message={error} />
      <FormActions>
        <Button
          label={t('vault.create')}
          icon={Vault}
          onPress={submit}
          loading={create.isPending}
          disabled={!labels.service.trim()}
        />
      </FormActions>
    </Screen>
  );
}
