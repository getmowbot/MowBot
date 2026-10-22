/** The palette's colors, by role. */
export type Palette = Record<keyof typeof colors, string>;

/**
 * The dark palette, black and white (bots bring the color). Web maps these to CSS variables;
 * native apps use them directly. `lightColors` is its light twin.
 */
export const colors = {
  background: '#06070a',
  backgroundRaised: '#0b0d11',
  surface: '#101318',
  surfaceHover: '#161a21',
  surfaceActive: '#1c212a',
  border: 'rgba(255, 255, 255, 0.07)',
  borderStrong: 'rgba(255, 255, 255, 0.13)',
  text: '#eef1f6',
  textMuted: '#8d96a5',
  textFaint: '#5a6270',
  // Yin/yang: the accent is white, ink is near-black.
  accent: '#f3f4f6',
  accentStrong: '#ffffff',
  accentInk: '#07080a',
  danger: '#ff6b85',
  warning: '#ffc66b',
  info: '#7cc6ff',
} as const;

/** The light palette: the same roles, ink on white (the accent turns ink, its ink white). */
export const lightColors: Palette = {
  background: '#f4f5f8',
  backgroundRaised: '#ffffff',
  surface: '#ffffff',
  surfaceHover: '#f5f6f9',
  surfaceActive: '#eceef3',
  border: 'rgba(16, 19, 26, 0.08)',
  borderStrong: 'rgba(16, 19, 26, 0.15)',
  text: '#10131a',
  textMuted: '#5b6371',
  textFaint: '#8c94a2',
  accent: '#141821',
  accentStrong: '#10131a',
  accentInk: '#ffffff',
  danger: '#d92d4b',
  warning: '#b26b00',
  info: '#1769d1',
};

export const radii = { sm: 8, md: 12, lg: 16, xl: 22, full: 9999 } as const;

/**
 * Motion vocabulary: critically damped springs (no overshoot, no bounce) and soft eases.
 * Values are framer-motion / Reanimated compatible.
 */
export const springs = {
  /** UI elements settling into place. */
  soft: { type: 'spring', stiffness: 260, damping: 32, mass: 0.9 },
  /** Small, quick responses (press, toggle). */
  snappy: { type: 'spring', stiffness: 520, damping: 40, mass: 0.7 },
  /** Eyes: fast, precise saccades. */
  gaze: { type: 'spring', stiffness: 380, damping: 34, mass: 0.6 },
  /** Slow drifts (thinking eyes, ambient). */
  drift: { type: 'spring', stiffness: 60, damping: 18, mass: 1 },
} as const;

export const easings = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;
