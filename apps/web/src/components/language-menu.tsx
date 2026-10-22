import { springs } from '@mowbot/design';
import { Check, Languages } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyLocale, currentLocale, LOCALE_NAMES, LOCALES } from '../i18n';
import { useChangeLocale } from '../lib/locale';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

/** Signed in: the account's language (the app's, and the one bots answer in), from the sidebar. */
export function LanguageMenu() {
  const { t } = useTranslation();
  const change = useChangeLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = currentLocale();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('language.label')}
        title={t('language.label')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Languages className="size-4" />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={t('language.label')}
            initial={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            transition={springs.snappy}
            className="glass absolute bottom-full right-0 z-50 mb-2 w-44 origin-bottom-right rounded-xl p-1"
          >
            {LOCALES.map((locale) => (
              <button
                key={locale}
                type="button"
                role="menuitemradio"
                aria-checked={locale === current}
                lang={locale}
                onClick={() => {
                  setOpen(false);
                  if (locale !== current) change.mutate(locale);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground/90 transition-colors duration-150 hover:bg-ink/[0.06]"
              >
                <span className="flex-1">{LOCALE_NAMES[locale]}</span>
                {locale === current && <Check className="size-4 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Before signing in: the language of this browser, kept for next time. */
export function LanguageSwitch() {
  const { t } = useTranslation();
  const current = currentLocale();
  return (
    <fieldset
      aria-label={t('language.label')}
      className="flex items-center justify-center gap-1 text-xs"
    >
      {LOCALES.map((locale, index) => (
        <Fragment key={locale}>
          {index > 0 && (
            <span aria-hidden className="text-faint">
              ·
            </span>
          )}
          <button
            type="button"
            lang={locale}
            aria-pressed={locale === current}
            onClick={() => applyLocale(locale)}
            className={cn(
              'rounded-md px-1.5 py-1 transition-colors duration-200',
              locale === current ? 'text-foreground' : 'text-faint hover:text-muted-foreground',
            )}
          >
            {LOCALE_NAMES[locale]}
          </button>
        </Fragment>
      ))}
    </fieldset>
  );
}
