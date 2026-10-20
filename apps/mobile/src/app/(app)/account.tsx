import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError, Loading } from '../../components/admin/parts';
import { FormActions, Screen } from '../../components/screen';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { adminError, useUpdateMe } from '../../lib/admin-queries';
import { useMe } from '../../lib/queries';

/** The owner's name (how bots call them). The language is chosen in Settings. */
export default function AccountScreen() {
  const { t } = useTranslation();
  const me = useMe();
  const update = useUpdateMe();
  const current = me.data?.owner.displayName ?? '';
  // null: untouched, shows the saved name (which may still be loading).
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (draft ?? current).trim();

  const save = () => {
    if (!name) {
      setError(t('appAdmin.account.nameRequired'));
      return;
    }
    setError(null);
    update.mutate(
      { displayName: name },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(adminError(err, t('appAdmin.account.notSaved'))),
      },
    );
  };

  return (
    <Screen title={t('settings.account')}>
      {me.isPending ? (
        <Loading />
      ) : (
        <>
          <Field
            label={t('appAdmin.account.name')}
            hint={t('appAdmin.account.nameHint')}
            value={draft ?? current}
            onChangeText={setDraft}
            maxLength={100}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="done"
            onSubmitEditing={save}
          />
          <FormError message={error} />
          <FormActions>
            <Button
              label={t('common.save')}
              onPress={save}
              loading={update.isPending}
              disabled={name === current}
            />
          </FormActions>
        </>
      )}
    </Screen>
  );
}
