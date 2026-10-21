import { describe, expect, it } from 'vitest';
import { type Listing, modelGroups } from './models';

const openrouter = { id: 'p-or', name: 'OpenRouter', defaultModel: 'deepseek/deepseek-v4.1-flash' };
const openai = { id: 'p-oa', name: 'OpenAI', defaultModel: null };

const ready = (...ids: string[]): Listing => ({ state: 'ready', items: ids.map((id) => ({ id })) });

describe('the models /model offers', () => {
  const listings = new Map<string, Listing>([
    ['p-or', ready('qwen/qwen3-coder', 'deepseek/deepseek-v4.1-flash', 'moonshot/kimi-k3')],
    [
      'p-oa',
      { state: 'ready', items: [{ id: 'gpt-6.1', name: 'GPT-6.1' }, { id: 'gpt-6.1-mini' }] },
    ],
  ]);
  const bot = { providerId: 'p-or', model: 'deepseek/deepseek-v4.1-flash' };

  it('groups them by provider, the bot’s own first and marked', () => {
    const groups = modelGroups([openrouter, openai], listings, bot, '');
    expect(groups.map((g) => g.provider.name)).toEqual(['OpenRouter', 'OpenAI']);
    expect(groups[0]?.models.map((m) => [m.id, m.current])).toEqual([
      ['deepseek/deepseek-v4.1-flash', true],
      ['qwen/qwen3-coder', false],
      ['moonshot/kimi-k3', false],
    ]);
    expect(groups[1]?.models.map((m) => [m.id, m.name])).toEqual([
      ['gpt-6.1', 'GPT-6.1'],
      ['gpt-6.1-mini', null],
    ]);
  });

  it('keeps those with every word typed, in the provider, id or name', () => {
    const ids = (query: string) =>
      modelGroups([openrouter, openai], listings, bot, query).flatMap((g) =>
        g.models.map((m) => m.id),
      );
    expect(ids('gpt mini')).toEqual(['gpt-6.1-mini']);
    expect(ids('openai')).toEqual(['gpt-6.1', 'gpt-6.1-mini']);
    expect(ids('KIMI')).toEqual(['moonshot/kimi-k3']);
    expect(ids('flash v4')).toEqual(['deepseek/deepseek-v4.1-flash']);
    // No provider left without a match.
    expect(modelGroups([openrouter, openai], listings, bot, 'gpt')).toHaveLength(1);
    expect(ids('llama')).toEqual([]);
  });

  it('puts the ids that start with what is typed first', () => {
    const groups = modelGroups(
      [openai],
      new Map([['p-oa', ready('o5-gpt-wrapper', 'gpt-6.1')]]),
      { providerId: null, model: null },
      'gpt',
    );
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['gpt-6.1', 'o5-gpt-wrapper']);
  });

  it('always offers the default and the bot’s model, even when the endpoint cannot list them', () => {
    const groups = modelGroups(
      [openrouter],
      new Map([['p-or', { state: 'unreachable' }]]),
      { providerId: 'p-or', model: 'my/custom-model' },
      '',
    );
    expect(groups[0]).toMatchObject({ state: 'unreachable', more: 0 });
    expect(groups[0]?.models.map((m) => [m.id, m.current])).toEqual([
      ['my/custom-model', true],
      ['deepseek/deepseek-v4.1-flash', false],
    ]);
  });

  it('says a provider is still listing, and leaves out one that has nothing', () => {
    const groups = modelGroups([openrouter, openai], new Map(), bot, '');
    expect(groups.map((g) => [g.provider.name, g.state])).toEqual([
      ['OpenRouter', 'loading'],
      ['OpenAI', 'loading'],
    ]);
    expect(groups[1]?.models).toEqual([]);
    const empty = modelGroups([openai], new Map([['p-oa', ready()]]), bot, '');
    expect(empty).toEqual([]);
  });

  it('shows a few per provider and counts the others', () => {
    const many = ready(...Array.from({ length: 30 }, (_, i) => `model-${i}`));
    const [group] = modelGroups([openai], new Map([['p-oa', many]]), bot, '', 12);
    expect(group?.models).toHaveLength(12);
    expect(group?.more).toBe(18);
    const [narrowed] = modelGroups([openai], new Map([['p-oa', many]]), bot, 'model-2', 12);
    expect(narrowed?.models.map((m) => m.id)).toEqual([
      'model-2',
      'model-20',
      'model-21',
      'model-22',
      'model-23',
      'model-24',
      'model-25',
      'model-26',
      'model-27',
      'model-28',
      'model-29',
    ]);
    expect(narrowed?.more).toBe(0);
  });
});
