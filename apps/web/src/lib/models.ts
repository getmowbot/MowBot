import type { ModelList, Provider } from '@mowbot/contract';
import { fold } from './chat-input';

type ListedModel = ModelList['items'][number];

/** What a provider's endpoint said of its models. */
export type Listing =
  | { state: 'loading' }
  | { state: 'ready'; items: ListedModel[] }
  | { state: 'unreachable' };

export interface ModelChoice {
  providerId: string;
  /** What the bot uses. */
  id: string;
  /** What to show, when the endpoint has a display name. */
  name: string | null;
  /** The bot's model now. */
  current: boolean;
}

export interface ModelGroup {
  provider: Pick<Provider, 'id' | 'name'>;
  state: Listing['state'];
  models: ModelChoice[];
  /** Matching models left out (a provider may list hundreds): typing narrows them down. */
  more: number;
}

/** Shown per provider before typing narrows the list. */
export const MODELS_PER_PROVIDER = 12;

/**
 * The models `/model` offers, by provider: those whose provider, id or name has every word of
 * `query`, the bot's own first. The provider's default and the bot's model are always offered,
 * even when the endpoint does not list them (or cannot be reached).
 */
export function modelGroups(
  providers: readonly Pick<Provider, 'id' | 'name' | 'defaultModel'>[],
  listings: ReadonlyMap<string, Listing>,
  bot: { providerId: string | null; model: string | null },
  query: string,
  limit = MODELS_PER_PROVIDER,
): ModelGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const groups: ModelGroup[] = [];
  for (const provider of providers) {
    const listing = listings.get(provider.id) ?? { state: 'loading' };
    const listed = listing.state === 'ready' ? listing.items : [];
    const known: ListedModel[] = [
      ...listed,
      ...[provider.defaultModel, bot.providerId === provider.id ? bot.model : null]
        .filter((id): id is string => Boolean(id))
        .map((id) => ({ id })),
    ].filter((model, index, all) => all.findIndex((m) => m.id === model.id) === index);
    const found = known
      .filter((model) => {
        const haystack = fold(`${provider.name} ${model.id} ${model.name ?? ''}`);
        return words.every((word) => haystack.includes(word));
      })
      .map(
        (model): ModelChoice => ({
          providerId: provider.id,
          id: model.id,
          name: model.name && model.name !== model.id ? model.name : null,
          current: bot.providerId === provider.id && bot.model === model.id,
        }),
      );
    const first = words[0];
    const rank = (model: ModelChoice) =>
      model.current ? 0 : first && fold(model.id).startsWith(first) ? 1 : 2;
    const sorted = found
      .map((model, index) => ({ model, index }))
      .sort((a, b) => rank(a.model) - rank(b.model) || a.index - b.index)
      .map(({ model }) => model);
    if (sorted.length === 0 && listing.state !== 'loading') continue;
    groups.push({
      provider: { id: provider.id, name: provider.name },
      state: listing.state,
      models: sorted.slice(0, limit),
      more: Math.max(0, sorted.length - limit),
    });
  }
  return groups;
}
