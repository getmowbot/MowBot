import type { Message } from '@mowbot/contract';
import { reasoningHeadline } from '@mowbot/design';
import { describe, expect, it } from 'vitest';
import { isIncoming } from './incoming';

describe('reasoningHeadline', () => {
  it('takes the latest bold headline of a summary', () => {
    const text =
      '**Reading the brief**\n\nThe user wants a page.**Comparing the two layouts**\n\nThe grid';
    expect(reasoningHeadline(text)).toBe('Comparing the two layouts');
  });

  it('else takes the latest finished sentence, not the one being written', () => {
    expect(reasoningHeadline('Je regarde la maquette. Puis je vérifie les liens. Ensuite je')).toBe(
      'Puis je vérifie les liens',
    );
    expect(reasoningHeadline('Je regarde la maqu')).toBe('');
  });

  it('keeps it to one line', () => {
    const long = `**${'Une très longue réflexion '.repeat(10)}**`;
    expect(reasoningHeadline(long).length).toBeLessThanOrEqual(90);
    expect(reasoningHeadline(long).endsWith('…')).toBe(true);
  });
});

describe('isIncoming', () => {
  it('leaves out the hub telling a bot to go on', () => {
    const resume = {
      role: 'user',
      fromBotId: null,
      fromName: null,
      kind: 'routine',
      resume: 2,
    } as Message;
    expect(isIncoming(resume)).toBe(false);
    expect(isIncoming({ ...resume, resume: null })).toBe(true);
  });
});
