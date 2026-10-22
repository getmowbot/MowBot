/** Longest headline of a bot's reasoning, as the apps show it on one line. */
export const REASONING_HEADLINE_MAX = 90;

const clip = (text: string) =>
  text.length > REASONING_HEADLINE_MAX
    ? `${text.slice(0, REASONING_HEADLINE_MAX - 1).trimEnd()}…`
    : text;

/**
 * What a bot is thinking about, in a few words, from its reasoning so far: the latest bold
 * headline of a summary (« **Comparing the two layouts** »), or else its latest finished
 * sentence. '' while nothing is finished yet.
 */
export function reasoningHeadline(text: string): string {
  const headlines = [...text.matchAll(/\*\*([^*\n]{3,}?)\*\*/g)];
  const last = headlines.at(-1)?.[1]?.trim();
  if (last) return clip(last.replace(/[.:…]+$/, ''));
  // Finished sentences only: the one being written changes at every word.
  const sentences = text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?](?=\s|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 3);
  const sentence = sentences?.at(-1);
  return sentence ? clip(sentence.replace(/[.]+$/, '')) : '';
}
