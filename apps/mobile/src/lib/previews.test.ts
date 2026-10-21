import { describe, expect, it } from 'vitest';
import { untilLabel } from './previews';

describe('untilLabel', () => {
  const now = new Date(2026, 9, 22, 9, 0);

  it('gives the time alone when the preview ends today', () => {
    const label = untilLabel(new Date(2026, 9, 22, 18, 42).toISOString(), 'fr', now);
    expect(label).toContain('18');
    expect(label).toContain('42');
    expect(label).not.toMatch(/jeu|ven/i);
  });

  it('adds the day when it ends tomorrow', () => {
    const label = untilLabel(new Date(2026, 9, 23, 8, 5).toISOString(), 'fr', now);
    expect(label).toMatch(/ven/i);
    expect(label).toContain('08');
  });
});
