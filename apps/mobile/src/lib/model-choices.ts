import type { Provider } from '@mowbot/contract';
import { fold } from './chat-input';

/** What a provider's endpoint said of its models (their ids). */
export type Listing =
  | { state: 'loading' }
  | { state: 'ready'; ids: string[] }
  | { state: 'unreachable' };

export interface ModelChoice {
  providerId: string;
  /** What the bot uses. */
  id: string;
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
export const MODELS_PER_PROVIDER = 8;

/**
 * The models `/model` offers, by provider: those whose provider or id has every word of `query`,
 * the bot's own first. The provider's default and the bot's model are always offered, even when
 * the endpoint does not list them (or cannot be reached).
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
    const listed = listing.state === 'ready' ? listing.ids : [];
    const ids = [
      ...new Set([
        ...listed,
        ...[provider.defaultModel, bot.providerId === provider.id ? bot.model : null].filter(
          (id): id is string => Boolean(id),
        ),
      ]),
    ];
    const found = ids
      .filter((id) => {
        const haystack = fold(`${provider.name} ${id}`);
        return words.every((word) => haystack.includes(word));
      })
      .map(
        (id): ModelChoice => ({
          providerId: provider.id,
          id,
          current: bot.providerId === provider.id && bot.model === id,
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
