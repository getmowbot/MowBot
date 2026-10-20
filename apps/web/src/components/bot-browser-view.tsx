import { Globe, MonitorUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { problemMessage } from '../lib/auth';
import { useBotBrowser, useShowBotBrowser } from '../lib/queries';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** Two or more views of a computer: its screen, or a bot's own window. */
export function ViewSwitch<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: NoInfer<T>; label: string }[];
  onChange(value: NoInfer<T>): void;
}) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border-strong p-0.5 text-xs">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'shrink-0 rounded-md px-2.5 py-1 transition-colors duration-200',
            option.value === value
              ? 'bg-white/10 text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Live view of a bot's own Chrome window: it browses without the screen, so the computer's
 * desktop doesn't show it. `onShown` runs once the window was put in front on the screen.
 */
export function BotBrowserView({
  botId,
  botName,
  onShown,
}: {
  botId: string;
  botName: string;
  onShown?(): void;
}) {
  const { t } = useTranslation();
  const view = useBotBrowser(botId);
  const show = useShowBotBrowser(botId);
  const page = view.data;

  if (!page?.open || !page.image) {
    return (
      <div className="grid aspect-[16/10] place-items-center rounded-lg border border-dashed border-border-strong p-6 text-center">
        <div className="space-y-1">
          <p className="text-sm">
            {view.isPending ? t('common.loading') : t('desktop.noPage', { name: botName })}
          </p>
          {!view.isPending && (
            <p className="text-xs text-muted-foreground">{t('desktop.noPageHint')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{page.title || page.url}</p>
          <p className="truncate text-xs text-faint">{page.url}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={show.isPending}
          onClick={() => show.mutate(undefined, { onSuccess: () => onShown?.() })}
        >
          <MonitorUp className="size-3.5" />
          <span className="hidden sm:inline">{t('desktop.showOnScreen')}</span>
        </Button>
      </div>
      {show.isError && (
        <p role="alert" className="text-xs text-destructive">
          {problemMessage(show.error, t('common.actionFailed'))}
        </p>
      )}
      <img
        src={`data:image/jpeg;base64,${page.image}`}
        alt={t('desktop.botPage', { name: botName })}
        className="max-h-[calc(100dvh-14rem)] w-full rounded-lg border border-border-strong bg-black object-contain object-top"
      />
    </div>
  );
}
