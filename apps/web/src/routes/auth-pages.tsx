import { PASSWORD_MIN_LENGTH } from '@mowbot/contract';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label } from '../components/ui/form';
import { problemMessage, useAuth } from '../lib/auth';

function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-3 size-10" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <Card>{children}</Card>
      </div>
    </main>
  );
}

export function SetupPage() {
  const { setup } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirm')))
      return setError('Les mots de passe ne correspondent pas.');
    setPending(true);
    setError(null);
    try {
      await setup({
        setupToken: String(form.get('setupToken')).trim(),
        displayName: String(form.get('displayName')),
        password,
      });
    } catch (err) {
      setError(problemMessage(err, 'Configuration impossible.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Bienvenue sur MowBot"
      subtitle="Crée le compte propriétaire de cette instance."
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="setupToken">Jeton de configuration</Label>
          <Input id="setupToken" name="setupToken" required autoComplete="off" spellCheck={false} />
          <p className="text-xs text-muted-foreground">
            Affiché dans les logs du hub au premier démarrage.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="displayName">Ton nom</Label>
          <Input id="displayName" name="displayName" required maxLength={100} autoComplete="name" />
        </div>
        <input type="hidden" name="username" value="owner" autoComplete="username" />
        <div className="space-y-2">
          <Label htmlFor="password">Mot de passe</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">{PASSWORD_MIN_LENGTH} caractères minimum.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirmation</Label>
          <Input id="confirm" name="confirm" type="password" required autoComplete="new-password" />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Création…' : 'Créer le compte'}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password'));
    setPending(true);
    setError(null);
    try {
      await login(password);
    } catch (err) {
      setError(problemMessage(err, 'Connexion impossible.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title="MowBot" subtitle="Connecte-toi pour retrouver tes équipes.">
      <form className="space-y-4" onSubmit={onSubmit}>
        <input type="hidden" name="username" value="owner" autoComplete="username" />
        <div className="space-y-2">
          <Label htmlFor="password">Mot de passe</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
          />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? 'Connexion…' : 'Se connecter'}
        </Button>
      </form>
    </AuthLayout>
  );
}
