import { describe, expect, it } from 'vitest';
import { revealOffset } from './chat-scroll';

describe('chat scroll', () => {
  const visible = { top: 100, bottom: 500 };

  it('leaves a field in view alone', () => {
    expect(revealOffset({ top: 200, bottom: 250 }, visible)).toBe(0);
  });

  it('brings a field hidden under the header down', () => {
    expect(revealOffset({ top: 40, bottom: 90 }, visible)).toBe(60);
  });

  it('lifts a field hidden behind the keyboard', () => {
    expect(revealOffset({ top: 520, bottom: 570 }, visible)).toBe(-70);
  });

  it('keeps the top of a field taller than the room left', () => {
    expect(revealOffset({ top: 300, bottom: 800 }, visible)).toBe(-200);
  });
});
