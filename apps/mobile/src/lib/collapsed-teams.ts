import { useSyncExternalStore } from 'react';
import { readSync, write } from './storage';

/** The teams folded in the bot list, kept on this phone. */
function load(): Set<string> {
  try {
    const ids: unknown = JSON.parse(readSync('collapsedTeams') ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

let folded = load();
const listeners = new Set<() => void>();

export function toggleTeam(teamId: string): void {
  folded = new Set(folded);
  if (folded.has(teamId)) folded.delete(teamId);
  else folded.add(teamId);
  for (const listener of listeners) listener();
  void write('collapsedTeams', folded.size ? JSON.stringify([...folded]) : null);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The folded teams (re-renders when one is folded or unfolded). */
export function useCollapsedTeams(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => folded);
}
