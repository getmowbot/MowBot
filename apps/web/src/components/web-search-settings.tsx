import type { WebSearchProvider } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, problemMessage } from '../lib/auth';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Card, FormError, SecretInput } from './ui/form';

const PROVIDERS: WebSearchProvider[] = ['duckduckgo', 'brave', 'tavily'];

function useWebSearchSettings() {
  return useQuery({
    queryKey: ['web-search'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/settings/web-search');
      if (error || !data) throw error;
      return data;
    },
  });
}

/**
 * Where the bots' web searches go: DuckDuckGo by default (free, no key), or Brave Search or
 * Tavily with a key. They search from the hub, without their computer.
 */
export function WebSearchSettings() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const current = useWebSearchSettings();
  const [picked, setPicked] = useState<WebSearchProvider | null>(null);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const provider = picked ?? current.data?.provider ?? 'duckduckgo';
  const keyed = provider !== 'duckduckgo';
  // A key is kept only for the provider it was given for.
  const hasKey = current.data?.provider === provider && current.data.hasKey;
  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.PUT('/api/v1/settings/web-search', {
        body: { provider, ...(keyed && key.trim() ? { apiKey: key.trim() } : {}) },
      });
      if (error || !data) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['web-search'], data);
      setPicked(null);
      setKey('');
      setSaved(true);
    },
  });
  if (!current.data) return null;
  const changed = provider !== current.data.provider || Boolean(key.trim());

  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink/[0.05]">
          <Globe className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{t('webSearch.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('webSearch.subtitle')}</p>
        </div>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setSaved(false);
          save.mutate();
        }}
      >
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === provider}
              onClick={() => {
                setPicked(option);
                setSaved(false);
              }}
              className={cn(
                'inline-flex h-9 items-center rounded-full border px-4 text-sm transition-[background-color,border-color] duration-200',
                option === provider
                  ? 'border-ink/30 bg-ink/[0.07] font-medium'
                  : 'border-border-strong text-muted-foreground hover:border-ink/20 hover:text-foreground',
              )}
            >
              {t(`webSearch.providers.${option}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(`webSearch.hints.${provider}`)}</p>
        {keyed && (
          <SecretInput
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setSaved(false);
            }}
            placeholder={hasKey ? t('webSearch.keySaved') : t('webSearch.key')}
            aria-label={t('webSearch.key')}
          />
        )}
        <FormError
          message={save.isError ? problemMessage(save.error, t('webSearch.notSaved')) : null}
        />
        <div className="flex items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={save.isPending || !changed || (keyed && !hasKey && !key.trim())}
          >
            {t('common.save')}
          </Button>
          {saved && <span className="text-xs text-muted-foreground">{t('common.saved')}</span>}
        </div>
      </form>
    </Card>
  );
}
