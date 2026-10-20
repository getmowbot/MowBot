import { springs as motionSprings, radii, colors as tokens } from '@mowbot/design';
import { Platform } from 'react-native';

/** The shared black-and-white palette, plus the tonal surfaces Material 3 uses on Android. */
export const colors = {
  ...tokens,
  // Material 3 surface containers, stepped up from the near-black background (no dynamic color).
  surfaceContainerLow: '#0d1014',
  surfaceContainer: '#12151b',
  surfaceContainerHigh: '#181c23',
  surfaceContainerHighest: '#1f242c',
  ripple: 'rgba(255, 255, 255, 0.12)',
  rippleOnAccent: 'rgba(7, 8, 10, 0.14)',
  scrim: 'rgba(0, 0, 0, 0.5)',
  error: '#ff3d5e',
} as const;

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
