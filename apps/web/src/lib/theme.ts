import { useSyncExternalStore } from 'react';

/** What the user picked: the system's look, or always light, or always dark. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];

/** Also read by the script in index.html, before the first paint. */
const KEY = 'mowbot.theme';
/** The page's backdrop, for the browser's bars (as `--background` in styles.css). */
const BACKDROP: Record<Theme, string> = { dark: '#06070a', light: '#f4f5f8' };

const listeners = new Set<() => void>();
const system = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';

export function themeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // Storage off (private window): the system's look.
  }
  return 'system';
}

export const resolveTheme = (choice: ThemeChoice): Theme =>
  choice === 'system' ? system() : choice;

/** Puts the look on the page: `data-theme` drives the colors of styles.css. */
function paint(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BACKDROP[theme]);
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Kept for this visit only.
  }
  paint(resolveTheme(choice));
  for (const listener of listeners) listener();
}

// index.html painted it already, unless its script could not run.
if (typeof document !== 'undefined') paint(resolveTheme(themeChoice()));

// The system's look changes (evening, settings): followed while the user picked « system ».
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themeChoice() !== 'system') return;
    paint(system());
    for (const listener of listeners) listener();
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The look the page has now, and what the user picked. */
export function useTheme(): { choice: ThemeChoice; theme: Theme } {
  const choice = useSyncExternalStore(subscribe, themeChoice);
  const theme = useSyncExternalStore(subscribe, () => resolveTheme(themeChoice()));
  return { choice, theme };
}
