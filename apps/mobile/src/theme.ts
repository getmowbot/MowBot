import {
  lightColors,
  springs as motionSprings,
  type Palette,
  radii,
  colors as tokens,
} from '@mowbot/design';
import { useSyncExternalStore } from 'react';
import { Appearance, Platform } from 'react-native';
import { readSync, write } from './lib/storage';

/** The app's look: the phone's, or always light, or always dark. */
export type Scheme = 'light' | 'dark';
export type SchemePreference = 'system' | Scheme;

/** The shared palettes, plus the tonal surfaces Material 3 uses on Android (no dynamic color). */
const palettes = {
  dark: {
    ...tokens,
    // Stepped up from the near-black background.
    surfaceContainerLow: '#0d1014',
    surfaceContainer: '#12151b',
    surfaceContainerHigh: '#181c23',
    surfaceContainerHighest: '#1f242c',
    ripple: 'rgba(255, 255, 255, 0.12)',
    rippleOnAccent: 'rgba(7, 8, 10, 0.14)',
    scrim: 'rgba(0, 0, 0, 0.5)',
    error: '#ff3d5e',
    // The primary round button, as on the web: a white pebble lit from above.
    pebbleTop: '#ffffff',
    pebbleBottom: '#d9dde4',
    pebbleInk: '#07080a',
    pebbleRim: 'rgba(255, 255, 255, 0.95)',
    pebbleUnder: 'rgba(0, 0, 0, 0.18)',
    pebbleSheen: 'rgba(255, 255, 255, 0.95)',
    // The message field, as on the web: a lens of glass with a light along its edge.
    lensFill: 'rgba(16, 19, 24, 0.78)',
    lensFillOpaque: '#12151b',
    lensTop: 'rgba(255, 255, 255, 0.085)',
    lensBottom: 'rgba(255, 255, 255, 0.025)',
    lensShine: '#ffffff',
    lensRim: 'rgba(255, 255, 255, 0.2)',
    lensDepth: 'rgba(0, 0, 0, 0.28)',
    lensBeam: 'rgba(255, 255, 255, 0.55)',
    lensShadow: '#000000',
  },
  light: {
    ...lightColors,
    // Stepped down from the white surfaces.
    surfaceContainerLow: '#f7f8fb',
    surfaceContainer: '#eef0f4',
    surfaceContainerHigh: '#e8eaef',
    surfaceContainerHighest: '#e1e4ea',
    ripple: 'rgba(16, 19, 26, 0.1)',
    rippleOnAccent: 'rgba(255, 255, 255, 0.2)',
    scrim: 'rgba(0, 0, 0, 0.32)',
    error: '#d92d4b',
    // On light, the pebble is ink: the same light from above, the same reflection.
    pebbleTop: '#313744',
    pebbleBottom: '#0e1117',
    pebbleInk: '#ffffff',
    pebbleRim: 'rgba(255, 255, 255, 0.28)',
    pebbleUnder: 'rgba(0, 0, 0, 0.35)',
    pebbleSheen: 'rgba(255, 255, 255, 0.32)',
    lensFill: 'rgba(255, 255, 255, 0.82)',
    lensFillOpaque: '#ffffff',
    lensTop: 'rgba(255, 255, 255, 0.96)',
    lensBottom: 'rgba(244, 246, 250, 0.82)',
    lensShine: '#ffffff',
    lensRim: '#ffffff',
    lensDepth: 'rgba(16, 19, 26, 0.05)',
    lensBeam: 'rgba(16, 19, 26, 0.28)',
    lensShadow: '#10131a',
  },
} satisfies Record<Scheme, Palette & Record<string, string>>;

type Colors = Record<keyof (typeof palettes)['dark'], string>;

const isPreference = (value: string | null): value is SchemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

export function storedScheme(): SchemePreference {
  const stored = readSync('theme');
  return isPreference(stored) ? stored : 'system';
}

const resolve = (preference: SchemePreference): Scheme =>
  preference === 'system'
    ? Appearance.getColorScheme() === 'light'
      ? 'light'
      : 'dark'
    : preference;

let preference = storedScheme();
let scheme: Scheme = resolve(preference);
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

// The phone's look changes (evening, settings): followed while the user picked « system ».
Appearance.addChangeListener(() => {
  if (preference !== 'system') return;
  const next = resolve('system');
  if (next === scheme) return;
  scheme = next;
  changed();
});

/** Applies and remembers the user's choice. */
export async function setSchemePreference(next: SchemePreference): Promise<void> {
  preference = next;
  scheme = resolve(next);
  changed();
  await write('theme', next === 'system' ? null : next);
}

export const currentScheme = (): Scheme => scheme;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The look the app has now (re-renders when it changes). */
export function useScheme(): Scheme {
  return useSyncExternalStore(subscribe, currentScheme);
}

export function useSchemePreference(): SchemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/**
 * The colors of the current look. Read at render (`colors.text`), they follow the look; styles
 * made from them at import go through `themed`.
 */
export const colors: Colors = new Proxy({} as Colors, {
  get: (_target, key) => palettes[scheme][key as keyof Colors],
  has: (_target, key) => key in palettes[scheme],
  ownKeys: () => Reflect.ownKeys(palettes[scheme]),
  getOwnPropertyDescriptor: (_target, key) => ({
    enumerable: true,
    configurable: true,
    value: palettes[scheme][key as keyof Colors],
  }),
});

/** The palette of a look, as plain values (for what is made once per look). */
export const paletteOf = (look: Scheme): Colors => palettes[look];

/** The channels behind the see-through colors, for each look. */
const CHANNELS = {
  dark: {
    ink: '255, 255, 255',
    background: '6, 7, 10',
    text: '238, 241, 246',
    accent: '243, 244, 246',
    onAccent: '7, 8, 10',
    danger: '255, 107, 133',
  },
  light: {
    ink: '16, 19, 26',
    background: '244, 245, 248',
    text: '16, 19, 26',
    accent: '20, 24, 33',
    onAccent: '255, 255, 255',
    danger: '217, 45, 75',
  },
} as const;

const see = (role: keyof (typeof CHANNELS)['dark']) => (opacity: number) =>
  `rgba(${CHANNELS[scheme][role]}, ${opacity})`;

/**
 * See-through colors of the current look: `ink` for hovers, wells and hairlines (white on dark,
 * ink on light), `background` for fades into the page, `text` for softened text, `accent`,
 * `onAccent` (ink on the accent), `danger`.
 */
export const tint = {
  ink: see('ink'),
  background: see('background'),
  text: see('text'),
  accent: see('accent'),
  onAccent: see('onAccent'),
  danger: see('danger'),
} as const;

/**
 * Styles that follow the look: `themed(() => StyleSheet.create({...}))` makes them once per look,
 * from `colors`, and `styles.row` always reads the current one.
 */
export function themed<T extends object>(make: () => T): T {
  const made: Partial<Record<Scheme, T>> = {};
  const current = (): T => {
    let styles = made[scheme];
    if (!styles) {
      styles = make();
      made[scheme] = styles;
    }
    return styles;
  };
  return new Proxy({} as T, {
    get: (_target, key) => current()[key as keyof T],
    has: (_target, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => ({
      enumerable: true,
      configurable: true,
      value: current()[key as keyof T],
    }),
  });
}

export { radii };

type Spring = { stiffness: number; damping: number; mass: number };
const spring = ({ stiffness, damping, mass }: Spring): Spring => ({ stiffness, damping, mass });

/** Critically damped springs from @mowbot/design, in Reanimated's shape (no bounce). */
export const springs = {
  soft: spring(motionSprings.soft),
  snappy: spring(motionSprings.snappy),
  gaze: spring(motionSprings.gaze),
  drift: spring(motionSprings.drift),
} as const;

export const fonts = {
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

export const type = {
  largeTitle: { fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.4 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' as const, letterSpacing: -0.2 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15.5, lineHeight: 23 },
  callout: { fontSize: 14.5, lineHeight: 20 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
  overline: {
    fontSize: 11.5,
    lineHeight: 16,
    fontWeight: '600' as const,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
} as const;

/** Material 3 shape scale on Android, softer continuous corners on iOS. */
export const shape = {
  card: Platform.select({ ios: 22, default: 16 }),
  field: Platform.select({ ios: 14, default: 12 }),
  bar: Platform.select({ ios: 26, default: 28 }),
  chip: 9999,
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
