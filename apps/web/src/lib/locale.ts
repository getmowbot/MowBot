import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyLocale, currentLocale, i18n, type Locale } from '../i18n';
import { api, problemMessage } from './auth';
import { useMe } from './queries';

/**
 * Signed in, the app speaks the account's language: the one bots answer in. Follows it when it
 * changes (another device, or `useChangeLocale`).
 */
export function useAccountLocale(): void {
  const me = useMe();
  const locale = me.data?.owner.locale;
  useEffect(() => {
    if (locale) applyLocale(locale);
  }, [locale]);
}

/** Switches the app right away and saves the language on the account; reverts if that fails. */
export function useChangeLocale() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (locale: Locale) => {
      const { data, error } = await api.PATCH('/api/v1/me', { body: { locale } });
      if (error || !data) throw error;
      return data;
    },
    onMutate: (locale) => {
      const previous = currentLocale();
      applyLocale(locale);
      return { previous };
    },
    onSuccess: (me) => queryClient.setQueryData(['me'], me),
    onError: (err, _locale, context) => {
      if (context) applyLocale(context.previous);
      alert(problemMessage(err, i18n.t('language.changeFailed')));
    },
  });
}
