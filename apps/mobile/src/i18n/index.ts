// Hermes may lack Intl.PluralRules, which i18next needs for `_one` / `_other` keys.
import 'intl-pluralrules';
import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { readSync, write } from '../lib/storage';
import {
  FALLBACK_LANGUAGE,
  isLanguagePreference,
  type Language,
  type LanguagePreference,
  resolveLanguage,
} from './catalog';
import { en } from './en';
import { fr } from './fr';

export type { Language, LanguagePreference } from './catalog';

export function deviceLanguage(): string | null {
  return getLocales()[0]?.languageCode ?? null;
}

export function storedPreference(): LanguagePreference {
  const stored = readSync('language');
  return isLanguagePreference(stored) ? stored : 'system';
}

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: resolveLanguage(storedPreference(), deviceLanguage()),
  fallbackLng: FALLBACK_LANGUAGE,
  // Resources are bundled: initialize synchronously so the first frame is translated.
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Applies and remembers the user's choice. */
export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  await i18n.changeLanguage(resolveLanguage(preference, deviceLanguage()));
  await write('language', preference === 'system' ? null : preference);
}

export function currentLanguage(): Language {
  return i18n.language === 'en' ? 'en' : 'fr';
}

export default i18n;
