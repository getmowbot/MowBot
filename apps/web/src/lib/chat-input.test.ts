import { describe, expect, it } from 'vitest';
import { triggerAt } from './chat-input';

describe('what the composer reads in the text', () => {
  it('lists commands while a single word follows the slash', () => {
    expect(triggerAt('/', 1)).toEqual({ kind: 'command', query: '' });
    expect(triggerAt('/mod', 4)).toEqual({ kind: 'command', query: 'mod' });
    expect(triggerAt('/model', 6)).toEqual({ kind: 'command', query: 'model' });
  });

  it('lists the models once `/model` is followed by a space, narrowed by what comes next', () => {
    expect(triggerAt('/model ', 7)).toEqual({ kind: 'model', query: '' });
    expect(triggerAt('/model gpt mini', 15)).toEqual({ kind: 'model', query: 'gpt mini' });
    expect(triggerAt('/Model deepseek', 15)).toEqual({ kind: 'model', query: 'deepseek' });
  });

  it('leaves other texts alone', () => {
    expect(triggerAt('/model gpt\nplease', 17)).toBeNull();
    expect(triggerAt('/models gpt', 11)).toBeNull();
    expect(triggerAt('use /model gpt', 14)).toBeNull();
    expect(triggerAt('@No', 3)).toEqual({ kind: 'mention', query: 'No', start: 0, end: 3 });
  });
});
