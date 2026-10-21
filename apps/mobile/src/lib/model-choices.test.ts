import { describe, expect, it } from 'vitest';
import { type Listing, modelGroups } from './model-choices';

const openrouter = { id: 'p-or', name: 'OpenRouter', defaultModel: 'deepseek/deepseek-v4.1-flash' };
const openai = { id: 'p-oa', name: 'OpenAI', defaultModel: null };
const ready = (...ids: string[]): Listing => ({ state: 'ready', ids });

describe('the models /model offers', () => {
  const listings = new Map<string, Listing>([
    ['p-or', ready('qwen/qwen3-coder', 'deepseek/deepseek-v4.1-flash', 'moonshot/kimi-k3')],
    ['p-oa', ready('gpt-6.1', 'gpt-6.1-mini')],
  ]);
  const bot = { providerId: 'p-or', model: 'deepseek/deepseek-v4.1-flash' };
  const ids = (query: string) =>
    modelGroups([openrouter, openai], listings, bot, query).flatMap((g) =>
      g.models.map((m) => m.id),
    );

  it('groups them by provider, the bot’s own first and marked', () => {
    const groups = modelGroups([openrouter, openai], listings, bot, '');
    expect(groups.map((g) => g.provider.name)).toEqual(['OpenRouter', 'OpenAI']);
    expect(groups[0]?.models.map((m) => [m.id, m.current])).toEqual([
      ['deepseek/deepseek-v4.1-flash', true],
      ['qwen/qwen3-coder', false],
      ['moonshot/kimi-k3', false],
    ]);
  });

  it('keeps those with every word typed, in the provider or the id', () => {
    expect(ids('gpt mini')).toEqual(['gpt-6.1-mini']);
    expect(ids('openai')).toEqual(['gpt-6.1', 'gpt-6.1-mini']);
    expect(ids('KIMI')).toEqual(['moonshot/kimi-k3']);
    expect(ids('llama')).toEqual([]);
  });

  it('always offers the default and the bot’s model, even when the endpoint cannot list them', () => {
    const [group] = modelGroups(
      [openrouter],
      new Map([['p-or', { state: 'unreachable' }]]),
      { providerId: 'p-or', model: 'my/custom-model' },
      '',
    );
    expect(group?.state).toBe('unreachable');
    expect(group?.models.map((m) => [m.id, m.current])).toEqual([
      ['my/custom-model', true],
      ['deepseek/deepseek-v4.1-flash', false],
    ]);
  });

  it('says a provider is still listing, shows a few and counts the others', () => {
    expect(modelGroups([openai], new Map(), bot, '')).toMatchObject([
      { state: 'loading', models: [] },
    ]);
    const many = ready(...Array.from({ length: 20 }, (_, i) => `model-${i}`));
    const [group] = modelGroups([openai], new Map([['p-oa', many]]), bot, '', 8);
    expect(group?.models).toHaveLength(8);
    expect(group?.more).toBe(12);
  });
});
