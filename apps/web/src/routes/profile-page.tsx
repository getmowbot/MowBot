import { PASSWORD_MIN_LENGTH } from '@mowbot/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, MonitorDown, Server } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { FormError, Input, Label, SecretInput } from '../components/ui/form';
import { Switch } from '../components/ui/switch';
import { api, problemMessage } from '../lib/auth';
import { Reveal } from '../lib/motion';
import { desktop, inDesktopApp, useDesktopStatus } from '../lib/projects';
import { useMe } from '../lib/queries';

function NameForm({ name }: { name: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.PATCH('/api/v1/me', {
        body: { displayName: value.trim() },
      });
      if (error || !data) throw error;
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: (me) => queryClient.setQueryData(['me'], me),
    onError: (err) => setError(problemMessage(err, t('profile.nameFailed'))),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && value.trim() !== name) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <Label htmlFor="display-name">{t('profile.name')}</Label>
      <div className="flex gap-2">
        <Input
          id="display-name"
          value={value}
          maxLength={100}
          autoComplete="name"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!value.trim() || value.trim() === name || save.isPending}
        >
          {save.isSuccess && value.trim() === name ? (
            <Check className="size-4" />
          ) : (
            t('common.save')
          )}
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}

function PasswordForm() {
  const { t } = useTranslation();
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: async (body: { currentPassword: string; newPassword: string }) => {
      const { error } = await api.POST('/api/v1/me/password', {
        body: { ...body, signOutOthers },
      });
      if (error) throw error;
    },
    onMutate: () => {
      setError(null);
      setDone(false);
    },
    onSuccess: () => setDone(true),
    onError: (err) => setError(problemMessage(err, t('profile.passwordFailed'))),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const newPassword = String(form.get('new'));
    if (newPassword !== String(form.get('confirm'))) {
      setError(t('auth.passwordsDiffer'));
      return;
    }
    change.mutate(
      { currentPassword: String(form.get('current')), newPassword },
      { onSuccess: () => element.reset() },
    );
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="current-password">{t('profile.currentPassword')}</Label>
        <SecretInput
          id="current-password"
          name="current"
          required
          autoComplete="current-password"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new-password">{t('profile.newPassword')}</Label>
          <SecretInput
            id="new-password"
            name="new"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
          <p className="text-xs text-faint">
            {t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">{t('profile.confirmPassword')}</Label>
          <SecretInput
            id="confirm-password"
            name="confirm"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm">{t('profile.signOutOthers')}</p>
          <p className="text-xs text-muted-foreground">{t('profile.signOutOthersHint')}</p>
        </div>
        <Switch
          checked={signOutOthers}
          onChange={() => setSignOutOthers((v) => !v)}
          label={t('profile.signOutOthers')}
        />
      </div>
      <FormError message={error} />
      {done && <p className="text-sm text-emerald-400">{t('profile.passwordChanged')}</p>}
      <Button type="submit" disabled={change.isPending}>
        {t('profile.changePassword')}
      </Button>
    </form>
  );
}

/** In the desktop app: which hub it shows, going to another one, and the app's version. */
function DesktopHub() {
  const { t } = useTranslation();
  const status = useDesktopStatus();
  const [checked, setChecked] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: desktop.checkUpdate,
    // A newer version shows as a card (the app tells the page); up to date: said here.
    onSuccess: (found) => setChecked(found ? null : t('profile.upToDate')),
    onError: (err) => setChecked(err instanceof Error ? err.message : String(err)),
  });
  return (
    <section className="glass space-y-4 rounded-2xl p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Server className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('profile.hub')}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {status.data?.hubUrl ?? window.location.origin}
          </p>
        </div>
        <Button variant="outline" onClick={() => void desktop.changeHub()}>
          {t('profile.changeHub')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <MonitorDown className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('profile.app')}</p>
          <p className="text-xs text-muted-foreground">
            {status.data ? t('profile.version', { version: status.data.version }) : ''}
            {checked ? ` · ${checked}` : ''}
          </p>
        </div>
        <Button variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
          {t('profile.checkUpdates')}
        </Button>
      </div>
    </section>
  );
}

/** The account: name, hub password, and (in the desktop app) the hub it connects to. */
export function ProfilePage() {
  const { t } = useTranslation();
  const me = useMe();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">{t('shell.profile')}</h1>
        <p className="text-sm text-muted-foreground">{t('profile.subtitle')}</p>
      </Reveal>
      <section className="glass space-y-4 rounded-2xl p-5">
        {me.data ? (
          <NameForm key={me.data.owner.displayName} name={me.data.owner.displayName} />
        ) : (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
      </section>
      <section className="glass space-y-4 rounded-2xl p-5">
        <div>
          <h2 className="font-medium">{t('profile.password')}</h2>
          <p className="text-sm text-muted-foreground">{t('profile.passwordSubtitle')}</p>
        </div>
        <PasswordForm />
      </section>
      {inDesktopApp() && <DesktopHub />}
    </div>
  );
}
