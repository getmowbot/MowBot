import {
  ANTHROPIC_DEFAULT_MODEL,
  type Bot,
  CHATGPT_USAGE_URL,
  OPENAI_COMPATIBLE_PRESETS,
  PROVIDER_DEFAULT_URLS,
  type Provider,
  type ProviderKind,
} from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Download,
  ExternalLink,
  LogIn,
  MessageCircle,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { ProviderMark } from '../components/provider-mark';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select } from '../components/ui/form';
import { i18n } from '../i18n';
import { api, problemMessage } from '../lib/auth';
import {
  chatgptCredential,
  chatgptErrorMessage,
  DESKTOP_DOWNLOAD_URL,
  issuedClientOf,
} from '../lib/chatgpt';
import { Reveal } from '../lib/motion';
import { desktop, inDesktopApp } from '../lib/projects';
import { useBots, useProviders } from '../lib/queries';
import { cn } from '../lib/utils';

/** What can be added: the providers MowBot speaks to natively, well-known services, any other. */
interface ProviderOption {
  id: string;
  kind: ProviderKind;
  name: string;
  hint: string;
  /** A preset's address, filled in. */
  baseUrl?: string;
  /** No key needed (Ollama). */
  keyless?: boolean;
}

/** In the order shown. Product names stay as they are; only the generic kinds are worded. */
function providerOptions(): ProviderOption[] {
  return [
    {
      id: 'anthropic',
      kind: 'anthropic',
      name: 'Anthropic',
      hint: i18n.t('models.kinds.anthropicHint'),
    },
    { id: 'openai', kind: 'openai', name: 'OpenAI', hint: i18n.t('models.kinds.openaiHint') },
    {
      id: 'openai-chatgpt',
      kind: 'openai-chatgpt',
      name: i18n.t('models.kinds.chatgpt'),
      hint: i18n.t('models.kinds.chatgptHint'),
    },
    ...OPENAI_COMPATIBLE_PRESETS.map((preset) => ({
      id: preset.id,
      kind: 'openai-compatible' as const,
      name: preset.name,
      baseUrl: preset.baseUrl,
      keyless: preset.keyAt === null,
      hint: preset.keyAt
        ? i18n.t('models.kinds.presetHint', { site: preset.keyAt })
        : i18n.t('models.kinds.ollamaHint'),
    })),
    {
      id: 'command-code',
      kind: 'command-code',
      name: 'Command Code',
      hint: i18n.t('models.kinds.commandCodeHint'),
    },
    {
      id: 'openai-compatible',
      kind: 'openai-compatible',
      name: i18n.t('models.kinds.compatible'),
      hint: i18n.t('models.kinds.compatibleHint'),
    },
  ];
}

/** The models of a provider: `id` for the bots, `name` to show when there is one. */
function useModels(providerId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ['models', providerId],
    enabled: Boolean(providerId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/providers/{id}/models', {
        params: { path: { id: providerId as string } },
      });
      if (error?.type === 'urn:mowbot:problem:chatgpt_sign_in_required') {
        // The hub just found the ChatGPT session over: the provider says so now.
        void queryClient.invalidateQueries({ queryKey: ['providers'] });
      }
      if (error || !data) throw error;
      return data.items;
    },
  });
}

/** ChatGPT's own button style ("Sign in with ChatGPT"): plain, in the page's ink. */
const CHATGPT_BUTTON =
  'border-primary bg-primary text-primary-foreground hover:border-primary/90 hover:bg-primary/90';

function ManageUsage({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <a
      href={CHATGPT_USAGE_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline',
        className,
      )}
    >
      {t('models.chatgpt.manageUsage')} <ExternalLink className="size-3" />
    </a>
  );
}

/** Outside the desktop app: where the ChatGPT sign-in happens, and where to get the app. */
function DesktopOnly({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-xl border border-border-strong bg-ink/[0.02] p-4">
      <p className="text-[13px] text-muted-foreground">{text}</p>
      <a
        href={DESKTOP_DOWNLOAD_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-border-strong px-3 text-xs font-medium transition-colors hover:border-ink/20 hover:bg-ink/[0.06]"
      >
        <Download className="size-3.5" /> {t('models.chatgpt.download')}
      </a>
    </div>
  );
}

/**
 * Signing in with ChatGPT in the desktop app (for a new provider, or again for `providerId`):
 * the browser opens on OpenAI's page, the tokens go straight to the hub.
 */
function useChatgptSignIn<T>(
  save: (credential: Awaited<ReturnType<typeof chatgptCredential>>) => Promise<T>,
) {
  const { t } = useTranslation();
  // A sign-in that failed after OpenAI issued a client retries with it.
  const issued = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (providerId?: string) =>
      save(await chatgptCredential(providerId, providerId ? null : issued.current)),
    onMutate: () => setError(null),
    onSuccess: () => {
      issued.current = null;
    },
    onError: (caught) => {
      issued.current = issuedClientOf(caught) ?? issued.current;
      setError(chatgptErrorMessage(caught, t('models.addFailed')));
    },
  });
  return {
    start: (providerId?: string) => mutation.mutate(providerId),
    cancel: () => void desktop.cancelChatgptSignIn().catch(() => {}),
    pending: mutation.isPending,
    error,
  };
}

/** While the browser is on OpenAI's page: what to do, and a way out. */
function SignInWaiting({ onCancel }: { onCancel(): void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="shimmer-text text-[13px]">{t('models.chatgpt.waiting')}</span>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}

/** Adds an `openai-chatgpt` provider: sign-in in the desktop app, then a word on usage. */
function AddChatgpt({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState<string>(() => i18n.t('models.kinds.chatgpt'));
  const [welcome, setWelcome] = useState(false);
  const signIn = useChatgptSignIn(async (credential) => {
    const { data, error } = await api.POST('/api/v1/providers', {
      body: { kind: 'openai-chatgpt', name: name.trim() || 'ChatGPT', chatgpt: credential },
    });
    if (error || !data) throw error;
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['bots'] });
    setWelcome(true);
    return data;
  });

  if (welcome) {
    return (
      <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
        <p className="flex items-center gap-2 font-medium">
          <MessageCircle className="size-4" /> {t('models.chatgpt.welcomeTitle')}
        </p>
        <p className="text-[13px] text-muted-foreground">{t('models.chatgpt.welcomeBody')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onDone}>
            {t('models.chatgpt.gotIt')}
          </Button>
          <ManageUsage />
        </div>
      </div>
    );
  }

  if (!inDesktopApp()) {
    return (
      <div className="space-y-4">
        <DesktopOnly text={t('models.chatgpt.desktopOnly')} />
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        signIn.start();
      }}
    >
      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="chatgpt-name">{t('common.name')}</Label>
        <Input
          id="chatgpt-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          required
          disabled={signIn.pending}
        />
      </div>
      <FormError message={signIn.error} />
      {signIn.pending ? (
        <SignInWaiting onCancel={signIn.cancel} />
      ) : (
        <div className="flex gap-2">
          <Button type="submit" variant="outline" className={CHATGPT_BUTTON}>
            <LogIn className="size-4" /> {t('models.chatgpt.signIn')}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Signs in again to an `openai-chatgpt` provider (same account): its new tokens replace the old. */
function ChatgptSignInAgain({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);
  const signIn = useChatgptSignIn(async (credential) => {
    const { data, error } = await api.PATCH('/api/v1/providers/{id}', {
      params: { path: { id: provider.id } },
      body: { chatgpt: credential },
    });
    if (error || !data) throw error;
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['models', provider.id] });
    setDone(true);
    return data;
  });
  if (!inDesktopApp()) {
    return <p className="text-xs text-faint">{t('models.chatgpt.needsSignInDesktop')}</p>;
  }
  return (
    <div className="space-y-2">
      {signIn.pending ? (
        <SignInWaiting onCancel={signIn.cancel} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className={CHATGPT_BUTTON}
            onClick={() => {
              setDone(false);
              signIn.start(provider.id);
            }}
          >
            <LogIn className="size-3.5" /> {t('models.chatgpt.signInAgain')}
          </Button>
          {done && <span className="text-xs text-primary">{t('models.chatgpt.reconnected')}</span>}
        </div>
      )}
      <FormError message={signIn.error} />
    </div>
  );
}

/** The ChatGPT account behind a provider: email, plan, usage link, and what to do when needed. */
function ChatgptAccount({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const account = provider.chatgpt;
  if (!account) return null;
  if (account.status === 'needs_sign_in') {
    return (
      <div className="basis-full space-y-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] p-3">
        <p className="text-[13px]">{t('models.chatgpt.needsSignInBody')}</p>
        <ChatgptSignInAgain provider={provider} />
      </div>
    );
  }
  if (account.status === 'usage_limited') {
    return (
      <div className="basis-full space-y-1.5 rounded-xl border border-border-strong bg-ink/[0.02] p-3">
        <p className="text-[13px] font-medium">{t('models.chatgpt.limited')}</p>
        <p className="text-xs text-muted-foreground">{t('models.chatgpt.limitedBody')}</p>
        <ManageUsage />
      </div>
    );
  }
  return null;
}

/** Settings of an `openai-chatgpt` provider: its name, and signing in again. */
function EditChatgpt({ provider, onDone }: { provider: Provider; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const { error } = await api.PATCH('/api/v1/providers/{id}', {
        params: { path: { id: provider.id } },
        body: { name: String(form.get('name')).trim() },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('models.changesNotSaved'))),
  });
  return (
    <div className="space-y-4 pb-1 pt-2">
      <form
        className="space-y-4"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          setError(null);
          save.mutate(new FormData(event.currentTarget));
        }}
      >
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor={`name-${provider.id}`}>{t('common.name')}</Label>
          <Input id={`name-${provider.id}`} name="name" required defaultValue={provider.name} />
        </div>
        <FormError message={error} />
        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
          <Button variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
      {/* Signing in again on purpose (e.g. a new session): only the desktop app can. */}
      {provider.chatgpt?.status !== 'needs_sign_in' && inDesktopApp() && (
        <ChatgptSignInAgain provider={provider} />
      )}
    </div>
  );
}

interface HeaderRow {
  key: number;
  name: string;
  value: string;
}

let headerKey = 0;
const toRows = (headers: Record<string, string>): HeaderRow[] =>
  Object.entries(headers).map(([name, value]) => ({ key: headerKey++, name, value }));
const toHeaders = (rows: HeaderRow[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value.trim()]),
  );

/** Command Code only routes to upstreams that keep nothing when this header is set. */
const ZDR_HEADER = 'x-cmd-zdr';

function HeadersEditor({
  kind,
  rows,
  onChange,
}: {
  kind: ProviderKind;
  rows: HeaderRow[];
  onChange(rows: HeaderRow[]): void;
}) {
  const { t } = useTranslation();
  const zdr = rows.some((row) => row.name.trim().toLowerCase() === ZDR_HEADER);
  const set = (key: number, patch: Partial<HeaderRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{t('models.headers')}</span>
        {kind === 'command-code' && (
          <button
            type="button"
            aria-pressed={zdr}
            onClick={() =>
              onChange(
                zdr
                  ? rows.filter((row) => row.name.trim().toLowerCase() !== ZDR_HEADER)
                  : [...rows, { key: headerKey++, name: ZDR_HEADER, value: '1' }],
              )
            }
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors duration-200',
              zdr
                ? 'border-primary/50 bg-primary/[0.08] text-foreground'
                : 'border-border-strong text-muted-foreground hover:border-ink/20',
            )}
          >
            {zdr ? <Check className="size-3" /> : <ShieldCheck className="size-3" />}
            Zero Data Retention
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {rows.map((row) => (
          <motion.div
            key={row.key}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
            className="overflow-hidden"
          >
            <div className="flex gap-2 pb-0.5">
              <Input
                value={row.name}
                onChange={(event) => set(row.key, { name: event.target.value })}
                placeholder={t('common.name')}
                aria-label={t('models.headerName')}
                className="flex-[2] font-mono text-[13px]"
              />
              <Input
                value={row.value}
                onChange={(event) => set(row.key, { value: event.target.value })}
                placeholder={t('models.valuePlaceholder')}
                aria-label={t('models.headerValue')}
                className="flex-[3] font-mono text-[13px]"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                aria-label={t('models.removeHeader')}
              >
                <X className="size-4" />
              </Button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange([...rows, { key: headerKey++, name: '', value: '' }])}
      >
        <Plus className="size-3.5" /> {t('models.addHeader')}
      </Button>
      <p className="text-xs text-faint">
        {t('models.headersNote')}
        {kind === 'command-code' && ` ${t('models.zdrNote')}`}
      </p>
    </div>
  );
}

function EditProvider({ provider, onDone }: { provider: Provider; onDone(): void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState(() => toRows(provider.headers));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const apiKey = String(form.get('apiKey') ?? '').trim();
      const { error } = await api.PATCH('/api/v1/providers/{id}', {
        params: { path: { id: provider.id } },
        body: {
          name: String(form.get('name')).trim(),
          baseUrl: String(form.get('baseUrl')).trim(),
          apiKey: apiKey || undefined,
          headers: toHeaders(rows),
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['models', provider.id] });
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('models.changesNotSaved'))),
  });
  return (
    <form
      className="space-y-4 pb-1 pt-2"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`name-${provider.id}`}>{t('common.name')}</Label>
          <Input id={`name-${provider.id}`} name="name" required defaultValue={provider.name} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`key-${provider.id}`}>{t('models.apiKey')}</Label>
          <Input
            id={`key-${provider.id}`}
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={provider.hasApiKey ? t('models.apiKeyUnchanged') : t('models.apiKeyNone')}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`url-${provider.id}`}>{t('models.baseUrl')}</Label>
          <Input
            id={`url-${provider.id}`}
            name="baseUrl"
            type="url"
            required
            defaultValue={provider.baseUrl}
          />
        </div>
      </div>
      <HeadersEditor kind={provider.kind} rows={rows} onChange={setRows} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function AddProvider({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const options = providerOptions();
  const [picked, setPicked] = useState<string | null>(null);
  const current = options.find((option) => option.id === picked);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {options.map((option) => {
          const on = option.id === picked;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setPicked(option.id)}
              aria-pressed={on}
              className={cn(
                'relative flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left text-[13px] transition-colors duration-200 sm:gap-3 sm:px-3 sm:py-2.5 sm:text-sm',
                on
                  ? 'border-primary/50 text-foreground'
                  : 'border-border-strong text-muted-foreground hover:border-ink/20 hover:text-foreground',
              )}
            >
              {on && (
                <motion.span
                  layoutId="provider-kind"
                  transition={springs.soft}
                  className="absolute inset-0 rounded-xl bg-primary/[0.08]"
                />
              )}
              <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-ink/[0.05] sm:size-8">
                <ProviderMark kind={option.kind} baseUrl={option.baseUrl} />
              </span>
              <span className="relative line-clamp-2 min-w-0 font-medium leading-snug">
                {option.name}
              </span>
            </button>
          );
        })}
      </div>
      {current ? (
        <>
          <p className="text-[13px] text-muted-foreground">{current.hint}</p>
          {current.kind === 'openai-chatgpt' ? (
            <AddChatgpt onDone={onDone} />
          ) : (
            <AddKeyProvider key={current.id} option={current} onDone={onDone} />
          )}
        </>
      ) : (
        <p className="text-[13px] text-faint">{t('models.pick')}</p>
      )}
    </div>
  );
}

/** A provider reached with an API key (or none, Ollama): its address filled in for a preset. */
function AddKeyProvider({ option, onDone }: { option: ProviderOption; onDone(): void }) {
  const { t } = useTranslation();
  const { kind } = option;
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      const baseUrl = String(form.get('baseUrl') ?? '').trim();
      const defaultModel = String(form.get('defaultModel') ?? '').trim();
      const { data, error } = await api.POST('/api/v1/providers', {
        body: {
          kind,
          name: String(form.get('name')).trim(),
          apiKey: String(form.get('apiKey') ?? '').trim() || undefined,
          baseUrl: baseUrl || undefined,
          defaultModel: defaultModel || undefined,
          headers: toHeaders(rows),
        },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      onDone();
    },
    onError: (err) => setError(problemMessage(err, t('models.addFailed'))),
  });
  // A key everywhere but on a generic endpoint or a local Ollama.
  const keyRequired = !option.keyless && (kind !== 'openai-compatible' || Boolean(option.baseUrl));

  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        create.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">{t('common.name')}</Label>
          <Input id="name" name="name" required defaultValue={option.name} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="defaultModel">{t('models.defaultModel')}</Label>
          <Input
            id="defaultModel"
            name="defaultModel"
            placeholder={
              kind === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : t('models.defaultModelPlaceholder')
            }
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="baseUrl">{t('models.baseUrl')}</Label>
          <Input
            id="baseUrl"
            name="baseUrl"
            type="url"
            required={kind === 'openai-compatible'}
            defaultValue={option.baseUrl}
            placeholder={PROVIDER_DEFAULT_URLS[kind] ?? 'https://api.example.com/v1'}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="apiKey">{t('models.apiKey')}</Label>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            required={keyRequired}
            placeholder={
              kind === 'anthropic'
                ? 'sk-ant-…'
                : keyRequired
                  ? t('models.apiKeyPlaceholder')
                  : t('models.apiKeyOptional')
            }
          />
        </div>
      </div>
      <HeadersEditor kind={kind} rows={rows} onChange={setRows} />
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          <Plug className="size-4" />{' '}
          {create.isPending ? t('models.connecting') : t('models.connect')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const models = useModels(provider.id);
  const [editing, setEditing] = useState(false);
  const headerCount = Object.keys(provider.headers).length;
  const remove = useMutation({
    mutationFn: () =>
      api.DELETE('/api/v1/providers/{id}', { params: { path: { id: provider.id } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });
  const account = provider.chatgpt;
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <span className="grid size-9 place-items-center rounded-xl bg-ink/[0.05] text-foreground/85">
        <ProviderMark kind={provider.kind} baseUrl={provider.baseUrl} className="size-[18px]" />
      </span>
      {/* At least 10rem: on a phone the buttons go to the next line rather than squeeze it. */}
      <div className="min-w-40 flex-1">
        <p className={cn('font-medium', account && 'truncate')}>{provider.name}</p>
        {account ? (
          <>
            <p className="truncate text-xs text-faint">
              {[
                account.email,
                account.planType &&
                  t('models.chatgpt.plan', {
                    plan: account.planType.charAt(0).toUpperCase() + account.planType.slice(1),
                  }),
                account.status === 'needs_sign_in'
                  ? t('models.chatgpt.needsSignIn')
                  : t('models.chatgpt.usingPlan'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <ManageUsage />
          </>
        ) : (
          <p className="truncate text-xs text-faint">
            {provider.baseUrl}
            {headerCount > 0 && ` · ${t('models.headerCount', { count: headerCount })}`}
          </p>
        )}
      </div>
      <span
        className={cn(
          'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs',
          models.isSuccess
            ? 'border-primary/30 text-primary'
            : models.isError
              ? 'border-destructive/30 text-destructive'
              : 'border-border-strong text-muted-foreground',
        )}
      >
        {models.isSuccess ? (
          <>
            <Check className="size-3" /> {t('models.modelCount', { count: models.data.length })}
          </>
        ) : models.isError ? (
          account?.status === 'needs_sign_in' ? (
            t('models.chatgpt.needsSignIn')
          ) : (
            t('models.unreachable')
          )
        ) : (
          <span className="shimmer-text">{t('models.testing')}</span>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => models.refetch()}
        aria-label={t('models.retest')}
      >
        <RefreshCw className="size-4" />
      </Button>
      <Button
        variant={editing ? 'outline' : 'ghost'}
        size="icon"
        onClick={() => setEditing((v) => !v)}
        aria-label={t('common.settingsOf', { name: provider.name })}
        aria-expanded={editing}
      >
        <Settings2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() =>
          confirm(t('models.confirmDelete', { name: provider.name })) && remove.mutate()
        }
        aria-label={t('common.deleteNamed', { name: provider.name })}
      >
        <Trash2 className="size-4" />
      </Button>
      <ChatgptAccount provider={provider} />
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
            className="basis-full overflow-hidden"
          >
            {provider.kind === 'openai-chatgpt' ? (
              <EditChatgpt provider={provider} onDone={() => setEditing(false)} />
            ) : (
              <EditProvider provider={provider} onDone={() => setEditing(false)} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BotModel({ bot, providers }: { bot: Bot; providers: Provider[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const models = useModels(bot.providerId);
  const update = useMutation({
    mutationFn: async (body: { providerId?: string | null; model?: string | null }) => {
      const { error } = await api.PATCH('/api/v1/bots/{id}', {
        params: { path: { id: bot.id } },
        body,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bots'] }),
  });
  const options = models.data ?? [];
  const modelValue = bot.model ?? '';
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <BotAvatar seed={bot.avatarSeed} size={36} />
      <p className="min-w-24 flex-1 font-medium">{bot.name}</p>
      <Select
        className="w-auto min-w-40 flex-1 sm:flex-none"
        value={bot.providerId ?? ''}
        onChange={(event) => update.mutate({ providerId: event.target.value || null })}
        aria-label={t('models.providerOf', { name: bot.name })}
      >
        <option value="">{t('models.noProvider')}</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      {options.length > 0 ? (
        <Select
          className="w-auto min-w-48 flex-1 sm:flex-none"
          value={modelValue}
          onChange={(event) => update.mutate({ model: event.target.value || null })}
          aria-label={t('models.modelOf', { name: bot.name })}
        >
          {!options.some((option) => option.id === modelValue) && (
            <option value={modelValue}>{modelValue || t('models.choose')}</option>
          )}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name ?? option.id}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          className="w-auto min-w-48 flex-1 sm:flex-none"
          defaultValue={modelValue}
          key={modelValue}
          placeholder={t('models.modelName')}
          aria-label={t('models.modelOf', { name: bot.name })}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (value !== modelValue) update.mutate({ model: value || null });
          }}
        />
      )}
    </div>
  );
}

export function ModelsPage() {
  const { t } = useTranslation();
  const providers = useProviders();
  const bots = useBots();
  const [adding, setAdding] = useState(false);
  const list = providers.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">{t('shell.models')}</h1>
        <p className="text-sm text-muted-foreground">{t('models.subtitle')}</p>
      </Reveal>

      <Reveal delay={0.05}>
        <Card className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">{t('models.providers')}</h2>
            {!adding && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plug className="size-3.5" /> {t('models.add')}
              </Button>
            )}
          </div>
          <AnimatePresence initial={false}>
            {adding && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={springs.soft}
                className="overflow-hidden"
              >
                <div className="pb-2 pt-3">
                  <AddProvider onDone={() => setAdding(false)} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {list.length === 0 && !adding && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('models.empty')}</p>
          )}
          <div className="divide-y divide-border">
            {list.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} />
            ))}
          </div>
        </Card>
      </Reveal>

      {list.length > 0 && (
        <Reveal delay={0.1}>
          <Card className="space-y-1">
            <h2 className="font-medium">{t('models.perBot')}</h2>
            <div className="divide-y divide-border">
              {bots.data?.map((bot) => (
                <BotModel key={bot.id} bot={bot} providers={list} />
              ))}
            </div>
          </Card>
        </Reveal>
      )}
    </div>
  );
}
