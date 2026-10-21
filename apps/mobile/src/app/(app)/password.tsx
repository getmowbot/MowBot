import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TextInput } from 'react-native';
import { FormError, Note } from '../../components/admin/parts';
import { ListCard } from '../../components/list-card';
import { FormActions, Screen } from '../../components/screen';
import { Button } from '../../components/ui/button';
import { Field } from '../../components/ui/field';
import { ROW_INSET, SwitchRow } from '../../components/ui/rows';
import { useChangePassword } from '../../lib/admin-queries';
import { showInfo } from '../../lib/options-menu';
import {
  EMPTY_PASSWORD_DRAFT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordDraft,
  passwordChangeBody,
  passwordError,
  passwordProblem,
} from '../../lib/password';

/** Password managers fill the right fields and suggest a new one that the hub accepts. */
const CURRENT_INPUT = {
  secureTextEntry: true,
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'current-password',
  textContentType: 'password',
  maxLength: PASSWORD_MAX_LENGTH,
} as const;
const NEW_INPUT = {
  ...CURRENT_INPUT,
  autoComplete: 'new-password',
  textContentType: 'newPassword',
  passwordRules: `minlength: ${PASSWORD_MIN_LENGTH}; maxlength: ${PASSWORD_MAX_LENGTH};`,
} as const;

/** Changes the hub password; may sign out the other devices (this one stays signed in). */
export default function PasswordScreen() {
  const { t } = useTranslation();
  const change = useChangePassword();
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY_PASSWORD_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const nextInput = useRef<TextInput>(null);
  const confirmInput = useRef<TextInput>(null);
  const filled = Boolean(draft.current && draft.next && draft.confirm);

  const edit = (patch: Partial<PasswordDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = () => {
    if (!filled || change.isPending) return;
    const problem = passwordProblem(draft);
    if (problem) {
      setError(
        t(`appAdmin.password.problems.${problem}`, {
          min: PASSWORD_MIN_LENGTH,
          max: PASSWORD_MAX_LENGTH,
        }),
      );
      return;
    }
    setError(null);
    change.mutate(passwordChangeBody(draft), {
      onSuccess: (_, body) => {
        showInfo(
          t('appAdmin.password.changed'),
          body.signOutOthers ? t('appAdmin.password.othersSignedOut') : undefined,
        );
        router.back();
      },
      onError: (err) => setError(passwordError(err, t)),
    });
  };

  return (
    <Screen title={t('appAdmin.password.title')}>
      <Note>{t('appAdmin.password.subtitle')}</Note>
      <Field
        label={t('appAdmin.password.current')}
        value={draft.current}
        onChangeText={(current) => edit({ current })}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => nextInput.current?.focus()}
        {...CURRENT_INPUT}
      />
      <Field
        label={t('appAdmin.password.next')}
        hint={t('appAdmin.password.nextHint', { min: PASSWORD_MIN_LENGTH })}
        inputRef={nextInput}
        value={draft.next}
        onChangeText={(next) => edit({ next })}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmInput.current?.focus()}
        {...NEW_INPUT}
      />
      <Field
        label={t('appAdmin.password.confirm')}
        inputRef={confirmInput}
        value={draft.confirm}
        onChangeText={(confirm) => edit({ confirm })}
        returnKeyType="done"
        onSubmitEditing={save}
        {...NEW_INPUT}
      />
      <ListCard inset={ROW_INSET}>
        <SwitchRow
          label={t('appAdmin.password.signOutOthers')}
          hint={t('appAdmin.password.signOutOthersHint')}
          value={draft.signOutOthers}
          onChange={(signOutOthers) => edit({ signOutOthers })}
        />
      </ListCard>
      <FormError message={error} />
      <FormActions>
        <Button
          label={t('appAdmin.password.save')}
          onPress={save}
          loading={change.isPending}
          disabled={!filled}
        />
      </FormActions>
    </Screen>
  );
}
