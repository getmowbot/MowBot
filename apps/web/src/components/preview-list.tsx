import type { Preview } from '@mowbot/contract';
import { Check, Copy, ExternalLink, Globe, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import { problemMessage } from '../lib/auth';
import { untilLabel, usePreviews, useStopPreview } from '../lib/previews';
import { useBots } from '../lib/queries';
import { Button } from './ui/button';
import { Card } from './ui/form';

function PreviewRow({ preview, botName }: { preview: Preview; botName: string | null }) {
  const { t } = useTranslation();
  const stop = useStopPreview();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (window.isSecureContext && navigator.clipboard) {
      void navigator.clipboard.writeText(preview.url).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2_000);
        },
        () => window.prompt(t('previews.copyPrompt'), preview.url),
      );
    } else {
      // Plain HTTP on a LAN: no clipboard API, the link to copy by hand.
      window.prompt(t('previews.copyPrompt'), preview.url);
    }
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{preview.title}</p>
        <p className="text-xs text-muted-foreground">
          {t(botName ? 'previews.metaBot' : 'previews.meta', {
            port: preview.port,
            bot: botName ?? '',
            until: untilLabel(preview.expiresAt, currentLocale()),
          })}
        </p>
        {stop.isError && (
          <p role="alert" className="text-xs text-destructive">
            {problemMessage(stop.error, t('common.actionFailed'))}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          // Never `window.opener` for the page: it must not reach this tab.
          onClick={() => window.open(preview.url, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="size-3.5" /> {t('previews.open')}
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{' '}
          {copied ? t('previews.copied') : t('previews.copy')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={stop.isPending}
          onClick={() =>
            confirm(t('previews.confirmStop', { title: preview.title })) && stop.mutate(preview.id)
          }
        >
          <Square className="size-3.5" /> {t('previews.stop')}
        </Button>
      </div>
    </li>
  );
}

/** The web pages bots shared from this PC: open, copy the link, stop. */
export function PreviewList({ computerId }: { computerId: string }) {
  const { t } = useTranslation();
  const previews = usePreviews(computerId);
  const bots = useBots();
  const items = previews.data ?? [];
  if (items.length === 0) return null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">{t('previews.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('previews.hint')}</p>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {items.map((preview) => (
          <PreviewRow
            key={preview.id}
            preview={preview}
            botName={bots.data?.find((b) => b.id === preview.botId)?.name ?? null}
          />
        ))}
      </ul>
    </Card>
  );
}
