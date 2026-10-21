import type { Mention, MessageMention } from '@mowbot/contract';

/** For matching: lower case, without accents. */
export const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Whether `query` appears in one of `fields`, case and accents aside. */
export const matches = (query: string, ...fields: string[]) =>
  fields.some((field) => fold(field).includes(fold(query.trim())));

/** A mention picked in the composer: what it points at, and the text written after the @. */
export type Picked = Mention & { label: string };

/** What the user is typing: a command (`/sto`), or a mention at the cursor (`@No`). */
export type Trigger =
  | { kind: 'command'; query: string }
  | { kind: 'mention'; query: string; start: number; end: number };

/** `labels`: the mentions already picked, which do not open the list again. */
export function triggerAt(text: string, caret: number, labels: string[] = []): Trigger | null {
  if (/^\/\S*$/.test(text)) return { kind: 'command', query: text.slice(1) };
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1 || (at > 0 && !/\s/.test(before[at - 1] ?? ''))) return null;
  const query = before.slice(at + 1);
  // Names have spaces ("Équipe principale"); a line break or a long run ends the mention.
  if (query.includes('\n') || query.startsWith(' ') || query.length > 60) return null;
  if (labels.some((label) => query === label || query.startsWith(`${label} `))) return null;
  return { kind: 'mention', query, start: at, end: caret };
}

/** The text with the typed `@query` replaced by `@label `, and where the cursor goes. */
export function insertMention(
  text: string,
  trigger: Extract<Trigger, { kind: 'mention' }>,
  label: string,
): { text: string; caret: number } {
  const inserted = `@${label} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(trigger.end),
    caret: trigger.start + inserted.length,
  };
}

/** The picked mentions still written in the text, once each, as the hub takes them. */
export function mentionsToSend(text: string, picked: Picked[]): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const { label, ...mention } of picked) {
    const key = mention.kind === 'file' ? `file:${mention.path}` : `${mention.kind}:${mention.id}`;
    if (seen.has(key) || !text.includes(`@${label}`)) continue;
    seen.add(key);
    out.push(mention);
  }
  return out;
}

/** A message's text cut around its mentions, to show them highlighted. */
export function mentionSegments(
  text: string,
  mentions: MessageMention[],
): { text: string; mention?: MessageMention }[] {
  if (mentions.length === 0) return [{ text }];
  // Longest first: "@Équipe principale" before a bot named "Équipe".
  const sorted = [...mentions].sort((a, b) => b.label.length - a.label.length);
  const out: { text: string; mention?: MessageMention }[] = [];
  let plain = '';
  let i = 0;
  while (i < text.length) {
    const found =
      text[i] === '@' ? sorted.find((m) => text.startsWith(`@${m.label}`, i)) : undefined;
    if (found) {
      if (plain) out.push({ text: plain });
      plain = '';
      out.push({ text: `@${found.label}`, mention: found });
      i += found.label.length + 1;
    } else {
      plain += text[i];
      i += 1;
    }
  }
  if (plain) out.push({ text: plain });
  return out;
}
