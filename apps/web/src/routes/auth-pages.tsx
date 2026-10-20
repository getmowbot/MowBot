import { PASSWORD_MIN_LENGTH } from '@mowbot/contract';
import { motion } from 'motion/react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { LanguageSwitch } from '../components/language-menu';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label } from '../components/ui/form';
import { problemMessage, useAuth } from '../lib/auth';
import { reveal, stagger } from '../lib/motion';

/** The mascot greeting people at the door: its eyes follow the pointer. */
const MASCOT_SEED = 'mowbot-portier';

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
      <motion.div
        initial="hidden"
        animate="shown"
        variants={stagger}
        className="w-full max-w-sm space-y-7"
      >
        <motion.div variants={reveal} className="flex flex-col items-center gap-4 text-center">
          <BotAvatar seed={MASCOT_SEED} size={104} followPointer />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </motion.div>
        <motion.div variants={reveal}>
          <Card>{children}</Card>
        </motion.div>
        <motion.div variants={reveal}>
          <LanguageSwitch />
        </motion.div>
      </motion.div>
    </main>
  );
}

export function SetupPage() {
  const { t } = useTranslation();
  const { setup } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== String(form.get('confirm'))) {
      return setError(t('auth.passwordsDiffer'));
    }
    setPending(true);
    setError(null);
    try {
      await setup({
        setupToken: String(form.get('setupToken')).trim(),
        displayName: String(form.get('displayName')),
        password,
      });
    } catch (err) {
      setError(problemMessage(err, t('auth.setupFailed')));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title={t('auth.setupTitle')} subtitle={t('auth.setupSubtitle')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="setupToken">{t('auth.setupToken')}</Label>
          <Input id="setupToken" name="setupToken" required autoComplete="off" spellCheck={false} />
          <p className="text-xs text-faint">{t('auth.setupTokenHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="displayName">{t('auth.displayName')}</Label>
          <Input id="displayName" name="displayName" required maxLength={100} autoComplete="name" />
        </div>
        <input type="hidden" name="username" value="owner" autoComplete="username" />
        <div className="space-y-1.5">
          <Label htmlFor="password">{t('auth.password')}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
          <p className="text-xs text-faint">
            {t('auth.passwordHint', { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">{t('auth.confirm')}</Label>
          <Input id="confirm" name="confirm" type="password" required autoComplete="new-password" />
        </div>
        <FormError message={error} />
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t('common.creating') : t('auth.createAccount')}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
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
      setError(problemMessage(err, t('auth.loginFailed')));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout title={t('auth.loginTitle')} subtitle={t('auth.loginSubtitle')}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <input type="hidden" name="username" value="owner" autoComplete="username" />
        <div className="space-y-1.5">
          <Label htmlFor="password">{t('auth.password')}</Label>
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
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>
    </AuthLayout>
  );
}
