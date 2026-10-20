import type { Locale } from '@mowbot/contract';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { fr } from './fr';

export type { Locale };

export const LOCALES: readonly Locale[] = ['fr', 'en'];

/** Each language named in itself, so anyone finds theirs. */
export const LOCALE_NAMES: Record<Locale, string> = { fr: 'Français', en: 'English' };

const STORAGE_KEY = 'mowbot.locale';

const isLocale = (value: unknown): value is Locale => value === 'fr' || value === 'en';

/** The language picked on this browser last time (storage may be unavailable). */
function storedLocale(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLocale(): Locale {
  const language = navigator.languages?.[0] ?? navigator.language ?? '';
  return language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function currentLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : 'fr';
}

/**
 * Shows the app in `locale` and remembers it on this browser for the sign-in pages. Signed in,
 * the account's language wins: go through `useChangeLocale` so the hub (and the bots) follow.
 */
export function applyLocale(locale: Locale): void {
  if (i18n.language !== locale) void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Still applied for this visit.
  }
}

// Catalogs are bundled: initialisation is synchronous, texts are ready for the first render.
void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: storedLocale() ?? browserLocale(),
  fallbackLng: 'fr',
  supportedLngs: LOCALES,
  initAsync: false,
  // React escapes what it renders.
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});
document.documentElement.lang = currentLocale();

export { i18n };
