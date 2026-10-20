/**
 * A bot's look is derived from a seed so every client draws the same character: a flat,
 * solid-colored body and two small white pill eyes whose position shows where it looks,
 * plus a temperament (blink and gaze rhythm).
 */

export type BodyShape = 'circle' | 'squircle' | 'drop' | 'pebble';

export interface BotGenome {
  /** Solid body color (from BOT_COLORS). */
  color: string;
  body: BodyShape;
  /** Eye pill width/height and gap, in a 100×100 box. */
  eyeWidth: number;
  eyeHeight: number;
  eyeGap: number;
  /** Mean seconds between blinks. */
  blinkEvery: number;
  /** 0..1: how often and how far the eyes wander. */
  curiosity: number;
}

/** Saturated, flat colors that read well on the dark UI. */
export const BOT_COLORS = [
  '#4fb6a2', // teal
  '#f5a23a', // orange
  '#6457f2', // indigo
  '#8b5cf6', // violet
  '#3b82f6', // blue
  '#f26a33', // vermilion
  '#ec4f9a', // pink
  '#e8b923', // gold
  '#14b1d4', // cyan
] as const;

/** FNV-1a: stable 32-bit hash of the seed. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;
const between = (rand: () => number, min: number, max: number) => min + rand() * (max - min);

export function botGenome(seed: string): BotGenome {
  const rand = random(hash(seed));
  return {
    color: pick(rand, BOT_COLORS),
    // Mostly round, sometimes a softer silhouette.
    body: pick(rand, ['circle', 'circle', 'circle', 'squircle', 'drop', 'pebble'] as const),
    eyeWidth: between(rand, 9.5, 11.5),
    eyeHeight: between(rand, 19, 24),
    eyeGap: between(rand, 17, 21),
    blinkEvery: between(rand, 2.4, 5.2),
    curiosity: between(rand, 0.4, 1),
  };
}

/** Fresh random seed for a new bot. */
export function newBotSeed(): string {
  return Math.random().toString(36).slice(2, 12);
}
