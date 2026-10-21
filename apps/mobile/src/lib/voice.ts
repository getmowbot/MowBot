/**
 * Voice messages: what the recorder measures turned into a waveform, the gesture's outcome, the
 * times shown. No React, no native modules: unit tested.
 */

/** Shorter than this, the mic was tapped, not held: nothing is sent. */
export const MIN_RECORDING_MS = 600;
/** A recording is sent by itself once this long. */
export const MAX_RECORDING_MS = 10 * 60_000;
/** Waveform bars sent to the hub. */
export const PEAK_COUNT = 64;
/** Sliding the finger this far to the left (pt) drops the recording. */
export const CANCEL_DISTANCE = 90;
/** Quieter than this (dBFS), the meter reads silence. */
const FLOOR_DB = -60;

/**
 * The recorder's meter (dBFS: 0 the loudest, -160 silence) as a level from 0 to 1, linear in
 * dB above the floor: speech sits in the middle, a shout near 1.
 */
export function meteringToLevel(db: number | null | undefined): number {
  if (db === null || db === undefined || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

/**
 * `count` bars from the levels read while recording: the mean of each slice, the loudest at 1,
 * lifted by a square root so soft speech still shows (as the hub draws them).
 */
export function toPeaks(levels: readonly number[], count = PEAK_COUNT): number[] {
  if (levels.length === 0) return [];
  const bars = Math.min(count, levels.length);
  const means = Array.from({ length: bars }, (_, bar) => {
    const start = Math.floor((bar * levels.length) / bars);
    const end = Math.floor(((bar + 1) * levels.length) / bars);
    let sum = 0;
    for (let i = start; i < end; i++) sum += levels[i] ?? 0;
    return sum / Math.max(1, end - start);
  });
  const loudest = Math.max(...means);
  if (loudest <= 0) return means.map(() => 0);
  return means.map((value) => Math.round(Math.sqrt(value / loudest) * 100) / 100);
}

/** The waveform fit to `count` bars: the loudest of the ones merged, or stretched. */
export function fitPeaks(peaks: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (peaks.length === 0) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, bar) => {
    const start = Math.floor((bar * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * peaks.length) / count));
    return Math.max(...peaks.slice(start, end));
  });
}

/** `0:07`, `1:32`, `12:05` */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What letting go of the mic does: send, drop (slid away), or nothing (a tap, not a hold). */
export function releaseOutcome(durationMs: number, slideX: number): 'send' | 'cancel' | 'short' {
  if (slideX <= -CANCEL_DISTANCE) return 'cancel';
  return durationMs < MIN_RECORDING_MS ? 'short' : 'send';
}

/** How far the finger slid toward cancelling, 0–1 (the hint fades as it goes). */
export function cancelProgress(slideX: number): number {
  return Math.min(1, Math.max(0, -slideX / CANCEL_DISTANCE));
}

/** Played so far, 0–1. */
export function playedFraction(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(1, Math.max(0, positionMs / durationMs));
}
