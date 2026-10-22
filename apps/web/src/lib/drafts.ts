import { type SetStateAction, useCallback, useState } from 'react';

/** Drafts live on this device only: what the user was typing, by place (a bot's chat…). */
const PREFIX = 'mowbot.draft.';

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (text.trim()) localStorage.setItem(PREFIX + key, text);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage off (private window): the draft lasts as long as the page.
  }
}

/**
 * Text that survives leaving the page: kept under `key` as it is typed, back when the user
 * returns, gone once emptied (sent). Another `key` (another bot) has its own draft.
 */
export function useDraft(key: string): [string, (next: SetStateAction<string>) => void] {
  const [state, setState] = useState(() => ({ key, text: readDraft(key) }));
  const text = state.key === key ? state.text : readDraft(key);
  const setText = useCallback(
    (next: SetStateAction<string>) =>
      setState((current) => {
        const base = current.key === key ? current.text : readDraft(key);
        const value = typeof next === 'function' ? next(base) : next;
        saveDraft(key, value);
        return { key, text: value };
      }),
    [key],
  );
  return [text, setText];
}
