import { springs } from '@mowbot/design';
import { listen } from '@tauri-apps/api/event';
import { Download, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { desktop, inDesktopApp, type DesktopUpdate as Update } from '../lib/projects';
import { Button } from './ui/button';

/**
 * In the desktop app: says when a newer version is out (the app checks the releases itself)
 * and installs it, which restarts the app.
 */
export function DesktopUpdate() {
  const { t } = useTranslation();
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktopApp = inDesktopApp();

  useEffect(() => {
    if (!desktopApp) return;
    const offAvailable = listen<Update>('update-available', (event) => setUpdate(event.payload));
    const offProgress = listen<{ downloaded: number; total: number | null }>(
      'update-progress',
      ({ payload }) => setProgress(payload.total ? payload.downloaded / payload.total : null),
    );
    return () => {
      void offAvailable.then((off) => off());
      void offProgress.then((off) => off());
    };
  }, [desktopApp]);

  const install = async () => {
    setError(null);
    setProgress(0);
    try {
      await desktop.installUpdate();
    } catch (caught) {
      setProgress(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const shown = update && dismissed !== update.version;
  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={springs.soft}
          role="status"
          className="glass fixed right-4 bottom-4 z-[60] w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-4"
        >
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink/[0.06]">
              <Download className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {t('desktopUpdate.available', { version: update.version })}
              </p>
              <p className="text-xs text-muted-foreground">
                {progress !== null
                  ? t('desktopUpdate.installing')
                  : t('desktopUpdate.current', { version: update.current })}
              </p>
            </div>
            {progress === null && (
              <button
                type="button"
                onClick={() => setDismissed(update.version)}
                aria-label={t('desktopUpdate.later')}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          {progress !== null ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/[0.08]">
              <motion.div
                className="h-full rounded-full bg-primary"
                animate={{ width: `${Math.round(progress * 100)}%` }}
                transition={springs.soft}
              />
            </div>
          ) : (
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDismissed(update.version)}>
                {t('desktopUpdate.later')}
              </Button>
              <Button size="sm" onClick={() => void install()}>
                {t('desktopUpdate.install')}
              </Button>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
