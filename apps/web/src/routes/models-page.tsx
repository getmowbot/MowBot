import {
  type Bot,
  PROVIDER_DEFAULT_URLS,
  type Provider,
  type ProviderKind,
} from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  KeyRound,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from '../components/bot-avatar';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select } from '../components/ui/form';
import { i18n } from '../i18n';
import { api, problemMessage } from '../lib/auth';
import { Reveal } from '../lib/motion';
import { useBots, useProviders } from '../lib/queries';
import { cn } from '../lib/utils';

/** Product names stay as they are; only the generic kind is worded. */
const KINDS = [
  { kind: 'command-code', name: 'Command Code', hint: 'models.kinds.commandCodeHint' },
  { kind: 'openai', name: 'OpenAI', hint: 'models.kinds.openaiHint' },
  { kind: 'openai-compatible', name: null, hint: 'models.kinds.compatibleHint' },
] as const satisfies readonly { kind: ProviderKind; name: string | null; hint: string }[];

const kindTitle = (option: (typeof KINDS)[number]): string =>
  option.name ?? i18n.t('models.kinds.compatible');

function useModels(providerId: string | null | undefined) {
  return useQuery({
    queryKey: ['models', providerId],
    enabled: Boolean(providerId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/providers/{id}/models', {
        params: { path: { id: providerId as string } },
      });
      if (error || !data) throw error;
      return data.items.map((m) => m.id);
    },
  });
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
                : 'border-border-strong text-muted-foreground hover:border-white/20',
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
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ProviderKind>('command-code');
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
  const current = KINDS.find((k) => k.kind === kind);

  return (
    <form
      className="space-y-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setError(null);
        create.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((option) => (
          <button
            key={option.kind}
            type="button"
            onClick={() => setKind(option.kind)}
            className={cn(
              'relative rounded-xl border px-3 py-2.5 text-left text-sm transition-colors duration-200',
              kind === option.kind
                ? 'border-primary/50 text-foreground'
                : 'border-border-strong text-muted-foreground hover:border-white/20',
            )}
          >
            {kind === option.kind && (
              <motion.span
                layoutId="provider-kind"
                transition={springs.soft}
                className="absolute inset-0 rounded-xl bg-primary/[0.08]"
              />
            )}
            <span className="relative font-medium">{kindTitle(option)}</span>
          </button>
        ))}
      </div>
      <p className="text-[13px] text-muted-foreground">{current && t(current.hint)}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">{t('common.name')}</Label>
          <Input
            id="name"
            name="name"
            required
            defaultValue={current && kindTitle(current)}
            key={kind}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="defaultModel">{t('models.defaultModel')}</Label>
          <Input
            id="defaultModel"
            name="defaultModel"
            placeholder={t('models.defaultModelPlaceholder')}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="baseUrl">{t('models.baseUrl')}</Label>
          <Input
            id="baseUrl"
            name="baseUrl"
            type="url"
            required={kind === 'openai-compatible'}
            placeholder={PROVIDER_DEFAULT_URLS[kind] ?? 'https://openrouter.ai/api/v1'}
            key={`url-${kind}`}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="apiKey">{t('models.apiKey')}</Label>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={t('models.apiKeyPlaceholder')}
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
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <span className="grid size-9 place-items-center rounded-xl bg-white/[0.05]">
        <KeyRound className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{provider.name}</p>
        <p className="truncate text-xs text-faint">
          {provider.baseUrl}
          {headerCount > 0 && ` · ${t('models.headerCount', { count: headerCount })}`}
        </p>
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
          t('models.unreachable')
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
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.soft}
            className="basis-full overflow-hidden"
          >
            <EditProvider provider={provider} onDone={() => setEditing(false)} />
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
          {!options.includes(modelValue) && (
            <option value={modelValue}>{modelValue || t('models.choose')}</option>
          )}
          {options.map((id) => (
            <option key={id} value={id}>
              {id}
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
