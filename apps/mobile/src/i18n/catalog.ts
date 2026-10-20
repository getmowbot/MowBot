import type { fr } from './fr';

/** Same keys as the French catalog, any wording: a missing or extra key fails the typecheck. */
type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Catalog = Widen<typeof fr>;

export const LANGUAGES = ['fr', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
/** What the user picked in Settings: a language, or follow the phone. */
export type LanguagePreference = Language | 'system';

export const FALLBACK_LANGUAGE: Language = 'fr';

/** The phone's language if we have it, French otherwise. */
export function resolveLanguage(
  preference: LanguagePreference,
  deviceLanguage: string | null | undefined,
): Language {
  if (preference !== 'system') return preference;
  const code = deviceLanguage?.toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.find((language) => language === code) ?? FALLBACK_LANGUAGE;
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || LANGUAGES.includes(value as Language);
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Catalog };
  }
}
