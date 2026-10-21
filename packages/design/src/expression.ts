/**
 * How a character shows what its bot is doing: each eye's opening and tilt, the head's tilt,
 * the eyes' shape. Shared by every client so a bot looks the same everywhere.
 */

export type CharacterMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'sleeping' | 'error';

/** A mood, or the short beat of joy when the bot is done working. */
export type Expression = CharacterMood | 'happy';

export interface Face {
  /** Eye height multipliers, left then right (blinks multiply on top). */
  open: readonly [number, number];
  /** Eye rotation in degrees, left then right (inner corners down: worry). */
  tilt: readonly [number, number];
  /** Head tilt in degrees (positive leans right). */
  head: number;
  /** Pills; closed arcs (asleep); upturned arcs (smiling eyes). */
  shape: 'pill' | 'closed' | 'happy';
}

export const FACES: Record<Expression, Face> = {
  idle: { open: [1, 1], tilt: [0, 0], head: 0, shape: 'pill' },
  // Pondering: one eye narrows, the head leans, the gaze goes up.
  thinking: { open: [0.96, 0.66], tilt: [0, -7], head: -7, shape: 'pill' },
  // Focused: both eyes narrowed, reading.
  working: { open: [0.62, 0.62], tilt: [0, 0], head: 0, shape: 'pill' },
  // Expectant: eyes wide open, head slightly tilted.
  waiting: { open: [1.15, 1.15], tilt: [0, 0], head: 5, shape: 'pill' },
  sleeping: { open: [1, 1], tilt: [0, 0], head: -4, shape: 'closed' },
  error: { open: [0.72, 0.72], tilt: [16, -16], head: 0, shape: 'pill' },
  happy: { open: [1, 1], tilt: [0, 0], head: 3, shape: 'happy' },
};

/** How long the joy lasts once a bot is done (ms). */
export const HAPPY_MS = 1_800;

/** Busy moods: going back to idle from one of them is "done". */
export const isBusy = (mood: CharacterMood) => mood === 'working' || mood === 'thinking';

/** How the head follows the eyes: shift (body units per unit of gaze) and turn (degrees). */
export const HEAD_FOLLOW = { x: 6.5, y: 3.5, turn: 7 } as const;
