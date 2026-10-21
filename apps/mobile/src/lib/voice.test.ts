import { describe, expect, it } from 'vitest';
import {
  CANCEL_DISTANCE,
  cancelProgress,
  fitPeaks,
  formatDuration,
  meteringToLevel,
  playedFraction,
  releaseOutcome,
  toPeaks,
} from './voice';

describe('the recorder meter', () => {
  it('reads dBFS as a level from 0 to 1', () => {
    expect(meteringToLevel(0)).toBe(1);
    expect(meteringToLevel(-30)).toBe(0.5);
    expect(meteringToLevel(-60)).toBe(0);
    expect(meteringToLevel(-160)).toBe(0);
    expect(meteringToLevel(3)).toBe(1);
    expect(meteringToLevel(undefined)).toBe(0);
    expect(meteringToLevel(Number.NaN)).toBe(0);
  });
});

describe('waveforms', () => {
  it('turns the levels read while recording into bars, the loudest at 1', () => {
    const levels = [...Array(50).fill(0.1), ...Array(50).fill(0.4)];
    expect(toPeaks(levels, 4)).toEqual([0.5, 0.5, 1, 1]);
    expect(toPeaks(levels)).toHaveLength(64);
    // Fewer levels than bars: one bar each.
    expect(toPeaks([0.2, 0.8])).toEqual([0.5, 1]);
    expect(toPeaks([])).toEqual([]);
    expect(toPeaks([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('fits a waveform to the bars there is room for', () => {
    expect(fitPeaks([0.1, 0.9, 0.3, 0.4], 2)).toEqual([0.9, 0.4]);
    expect(fitPeaks([0.2, 0.6], 4)).toEqual([0.2, 0.2, 0.6, 0.6]);
    expect(fitPeaks([], 3)).toEqual([0, 0, 0]);
    expect(fitPeaks([0.5], 0)).toEqual([]);
  });
});

describe('the hold-to-record gesture', () => {
  it('sends a held recording, drops one slid away, ignores a tap', () => {
    expect(releaseOutcome(2_000, 0)).toBe('send');
    expect(releaseOutcome(2_000, -CANCEL_DISTANCE)).toBe('cancel');
    expect(releaseOutcome(2_000, -CANCEL_DISTANCE + 1)).toBe('send');
    expect(releaseOutcome(200, 0)).toBe('short');
    // Slid away counts even when short.
    expect(releaseOutcome(200, -200)).toBe('cancel');
  });

  it('measures how far the finger went toward cancelling', () => {
    expect(cancelProgress(0)).toBe(0);
    expect(cancelProgress(40)).toBe(0);
    expect(cancelProgress(-CANCEL_DISTANCE / 2)).toBe(0.5);
    expect(cancelProgress(-500)).toBe(1);
  });
});

describe('times', () => {
  it('shows minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_400)).toBe('0:07');
    expect(formatDuration(92_000)).toBe('1:32');
    expect(formatDuration(725_000)).toBe('12:05');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('knows how much was played', () => {
    expect(playedFraction(500, 2_000)).toBe(0.25);
    expect(playedFraction(3_000, 2_000)).toBe(1);
    expect(playedFraction(100, 0)).toBe(0);
  });
});
