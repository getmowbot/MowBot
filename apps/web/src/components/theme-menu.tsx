import { springs } from '@mowbot/design';
import { Check, type LucideIcon, Monitor, Moon, Sun } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setThemeChoice, THEME_CHOICES, type ThemeChoice, useTheme } from '../lib/theme';
import { Button } from './ui/button';

const ICONS: Record<ThemeChoice, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/** The app's look, from the sidebar: as the system, light or dark (kept on this device). */
export function ThemeMenu() {
  const { t } = useTranslation();
  const { choice, theme } = useTheme();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const Icon = theme === 'light' ? Sun : Moon;

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
        aria-label={t('theme.label')}
        title={t('theme.label')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon className="size-4" />
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label={t('theme.label')}
            initial={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: 6, scale: 0.97, filter: 'blur(4px)' }}
            transition={springs.snappy}
            className="glass absolute bottom-full right-0 z-50 mb-2 w-48 origin-bottom-right rounded-xl p-1"
          >
            {THEME_CHOICES.map((option) => {
              const OptionIcon = ICONS[option];
              return (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === choice}
                  onClick={() => {
                    setOpen(false);
                    setThemeChoice(option);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground/90 transition-colors duration-150 hover:bg-ink/[0.06]"
                >
                  <OptionIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{t(`theme.${option}`)}</span>
                  {option === choice && <Check className="size-4 shrink-0 text-muted-foreground" />}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
