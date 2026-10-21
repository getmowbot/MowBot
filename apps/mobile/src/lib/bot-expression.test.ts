import { describe, expect, it } from 'vitest';
import { bump, expressionAfter, glanceStretch, keyframes } from './bot-expression';

describe('expression after a mood change', () => {
  it('beams when a busy bot is done', () => {
    expect(expressionAfter('working', 'idle')).toBe('happy');
    expect(expressionAfter('thinking', 'idle')).toBe('happy');
  });

  it('shows the mood otherwise', () => {
    expect(expressionAfter('idle', 'idle')).toBe('idle');
    expect(expressionAfter('waiting', 'idle')).toBe('idle');
    expect(expressionAfter('sleeping', 'idle')).toBe('idle');
    expect(expressionAfter('error', 'idle')).toBe('idle');
    expect(expressionAfter('working', 'error')).toBe('error');
    expect(expressionAfter('thinking', 'working')).toBe('working');
    expect(expressionAfter('idle', 'sleeping')).toBe('sleeping');
  });
});

describe('glance stretch', () => {
  it('does not stretch when the eyes do not move sideways', () => {
    expect(glanceStretch(0, false).peak).toBe(1);
  });

  it('stretches more for a longer glance, up to a limit, either way', () => {
    const short = glanceStretch(0.2, false).peak;
    const long = glanceStretch(0.6, false).peak;
    expect(short).toBeGreaterThan(1);
    expect(long).toBeGreaterThan(short);
    expect(glanceStretch(-0.6, false).peak).toBe(long);
    expect(glanceStretch(2, false).peak).toBeCloseTo(1.28);
  });

  it('stretches less and slower on the drift spring', () => {
    const quick = glanceStretch(0.8, false);
    const slow = glanceStretch(0.8, true);
    expect(slow.peak).toBeLessThan(quick.peak);
    expect(slow.rise).toBeGreaterThan(quick.rise);
    expect(slow.fall).toBeGreaterThan(quick.fall);
  });
});

describe('cycles', () => {
  it('bumps up and back', () => {
    expect(bump(0)).toBeCloseTo(0);
    expect(bump(0.5)).toBeCloseTo(1);
    expect(bump(1)).toBeCloseTo(0);
    expect(bump(0.25)).toBeCloseTo(0.5);
  });

  it('goes through three keyframes', () => {
    expect(keyframes(0, 82, 92, 98)).toBe(82);
    expect(keyframes(0.5, 82, 92, 98)).toBe(92);
    expect(keyframes(1, 82, 92, 98)).toBe(98);
    // Easing out: past the halfway point of each segment early.
    expect(keyframes(0.25, 0, 1, 0)).toBeGreaterThan(0.5);
  });
});
