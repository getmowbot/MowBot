import {
  type Bot,
  PROVIDER_DEFAULT_URLS,
  type Provider,
  type ProviderKind,
} from '@mowbot/contract';
import { springs } from '@mowbot/design';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type FormEvent, useState } from 'react';
import { BotAvatar } from '../components/bot-avatar';
import { Button } from '../components/ui/button';
import { Card, FormError, Input, Label, Select } from '../components/ui/form';
import { api, problemMessage } from '../lib/auth';
import { Reveal } from '../lib/motion';
import { useBots, useProviders } from '../lib/queries';
import { cn } from '../lib/utils';

const KINDS: { kind: ProviderKind; title: string; hint: string }[] = [
  {
    kind: 'command-code',
    title: 'Command Code',
    hint: 'Clé de ton abonnement (Studio → API keys).',
  },
  { kind: 'openai', title: 'OpenAI', hint: 'Clé API de platform.openai.com.' },
  {
    kind: 'openai-compatible',
    title: 'Compatible OpenAI',
    hint: 'OpenRouter, Ollama, xAI, DeepSeek… : URL de base + clé.',
  },
];

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

function AddProvider({ onDone }: { onDone(): void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ProviderKind>('command-code');
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
    onError: (err) => setError(problemMessage(err, 'Impossible d’ajouter ce fournisseur.')),
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
            <span className="relative font-medium">{option.title}</span>
          </button>
        ))}
      </div>
      <p className="text-[13px] text-muted-foreground">{current?.hint}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Nom</Label>
          <Input id="name" name="name" required defaultValue={current?.title} key={kind} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="defaultModel">Modèle par défaut</Label>
          <Input id="defaultModel" name="defaultModel" placeholder="ex. gpt-5.1, kimi-k2…" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="baseUrl">URL de base</Label>
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
          <Label htmlFor="apiKey">Clé API</Label>
          <Input
            id="apiKey"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="Chiffrée sur le hub, jamais réaffichée"
          />
        </div>
      </div>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          <Plug className="size-4" /> {create.isPending ? 'Connexion…' : 'Connecter'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Annuler
        </Button>
      </div>
    </form>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const queryClient = useQueryClient();
  const models = useModels(provider.id);
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
        <p className="truncate text-xs text-faint">{provider.baseUrl}</p>
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
            <Check className="size-3" /> {models.data.length} modèles
          </>
        ) : models.isError ? (
          'Injoignable'
        ) : (
          <span className="shimmer-text">Test…</span>
        )}
      </span>
      <Button variant="ghost" size="icon" onClick={() => models.refetch()} aria-label="Retester">
        <RefreshCw className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => confirm(`Supprimer « ${provider.name} » ?`) && remove.mutate()}
        aria-label={`Supprimer ${provider.name}`}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

function BotModel({ bot, providers }: { bot: Bot; providers: Provider[] }) {
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
        aria-label={`Fournisseur de ${bot.name}`}
      >
        <option value="">Aucun fournisseur</option>
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
          aria-label={`Modèle de ${bot.name}`}
        >
          {!options.includes(modelValue) && (
            <option value={modelValue}>{modelValue || 'Choisir…'}</option>
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
          placeholder="Nom du modèle"
          aria-label={`Modèle de ${bot.name}`}
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
  const providers = useProviders();
  const bots = useBots();
  const [adding, setAdding] = useState(false);
  const list = providers.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Reveal>
        <h1 className="text-2xl font-semibold tracking-tight">Modèles</h1>
        <p className="text-sm text-muted-foreground">
          Les cerveaux de tes bots. Les clés sont chiffrées sur ton hub et ne quittent jamais le
          serveur.
        </p>
      </Reveal>

      <Reveal delay={0.05}>
        <Card className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Fournisseurs</h2>
            {!adding && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plug className="size-3.5" /> Ajouter
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
            <p className="py-6 text-center text-sm text-muted-foreground">
              Aucun fournisseur. Ajoute ta clé Command Code ou OpenAI pour réveiller le Chef.
            </p>
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
            <h2 className="font-medium">Modèle de chaque bot</h2>
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
