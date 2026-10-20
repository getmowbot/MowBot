/** A checked form value, or why it cannot be sent. */
export type Checked<V, P extends string> = { ok: true; value: V } | { ok: false; problem: P };

const ok = <V>(value: V) => ({ ok: true, value }) as const;
const fail = <P extends string>(problem: P) => ({ ok: false, problem }) as const;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What people type for a time of day → "HH:MM" (the hub's format), or null.
 * "7" → "07:00", "7:30" / "7h30" / "7.30" / "0730" → "07:30", "22h" → "22:00".
 */
export function normalizeTime(text: string): string | null {
  const value = text.trim();
  const match =
    /^(\d{1,2})(?:\s*[:hH.]\s*(\d{2})?)?$/.exec(value) ?? /^(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

export interface QuietHoursDraft {
  enabled: boolean;
  start: string;
  end: string;
}

export type QuietHoursProblem = 'start' | 'end' | 'same';

/** The quiet window to send (null: none); it may cross midnight, but cannot be empty. */
export function checkQuietHours(
  draft: QuietHoursDraft,
): Checked<{ start: string; end: string } | null, QuietHoursProblem> {
  if (!draft.enabled) return ok(null);
  const start = normalizeTime(draft.start);
  if (!start) return fail('start');
  const end = normalizeTime(draft.end);
  if (!end) return fail('end');
  if (start === end) return fail('same');
  return ok({ start, end });
}

/** The hub's floor for token budgets. */
export const MIN_BUDGET = 1000;

/** "50 000", "50,000" or "50000" → 50000; empty → null (no limit). */
export function checkBudget(text: string): Checked<number | null, 'budget'> {
  const digits = text.replace(/[\s  ,.'’_]/g, '');
  if (!digits) return ok(null);
  if (!/^\d+$/.test(digits)) return fail('budget');
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < MIN_BUDGET) return fail('budget');
  return ok(value);
}

export function formatTokens(value: number, language: string): string {
  try {
    return value.toLocaleString(language);
  } catch {
    return String(value);
  }
}
