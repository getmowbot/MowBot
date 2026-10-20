import 'i18next';
import type { fr } from './fr';

// Keys and interpolation variables of `t()` are checked against the French catalog.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof fr };
  }
}
