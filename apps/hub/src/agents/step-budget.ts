import type { ModelMessage, ToolResultPart } from 'ai';

/** Steps a turn may take: what the user asked gets more room than routines and check-ins. */
export const MAX_STEPS = 80;
export const MAX_AUTONOMOUS_STEPS = 30;

/** Tool results of the last steps reach the model whole; older ones are shortened. */
export const RECENT_STEPS = 6;
const KEPT_LINES = 8;
const KEPT_CHARS = 600;
export const SHORTENED = '[sortie raccourcie]';

/** Shown at the last step, where tools are off: the turn ends with words, not a tool call. */
export const LAST_STEP_NOTE: ModelMessage = {
  role: 'user',
  content:
    '[Note du système] Tu as atteint le nombre maximum d’étapes pour ce tour : tu ne peux plus ' +
    'utiliser d’outils. Résume en quelques lignes ce qui est fait et ce qui reste à faire. ' +
    'L’utilisateur pourra te demander de continuer.',
};

type ToolOutput = ToolResultPart['output'];

/** What a tool output says, as text (pictures and files become a placeholder). */
function outputText(output: ToolOutput): string | null {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value) ?? '';
    case 'content':
      return output.value.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
    default:
      return null;
  }
}

function shorten(output: ToolOutput): ToolOutput {
  const text = outputText(output);
  const media = output.type === 'content' && output.value.some((part) => part.type !== 'text');
  if (text === null || (!media && text.length <= KEPT_CHARS)) return output;
  const head = text.split('\n').slice(0, KEPT_LINES).join('\n').slice(0, KEPT_CHARS);
  const value = `${head}\n${SHORTENED}`;
  return output.type === 'error-text' || output.type === 'error-json'
    ? { type: 'error-text', value }
    : { type: 'text', value };
}

/**
 * Each step resends the whole conversation: big outputs of old steps (page snapshots, logs)
 * are cut to their first lines. The last `RECENT_STEPS` tool results stay as they are.
 */
export function shortenOldOutputs(messages: ModelMessage[], recent = RECENT_STEPS): ModelMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message?.role !== 'tool') continue;
    if (++seen <= recent) continue;
    out[i] = {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-result' ? { ...part, output: shorten(part.output) } : part,
      ),
    };
  }
  return out;
}
