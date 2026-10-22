import type { ModelMessage, ToolResultPart } from 'ai';

/** Steps a turn may take: what the user asked gets more room than routines and check-ins. */
export const MAX_STEPS = 80;
export const MAX_AUTONOMOUS_STEPS = 30;

/** Tool results of the last steps reach the model whole; older ones are shortened. */
export const RECENT_STEPS = 6;
const KEPT_LINES = 8;
const KEPT_CHARS = 600;
export const SHORTENED = '[sortie raccourcie]';

/**
 * A turn cut by the step limit goes on by itself this many times in a row; then the bot's lead
 * (or the Chef) is told and decides.
 */
export const MAX_RESUMES = 5;

/**
 * Shown at the last step, where tools are off: the turn ends with words, not a tool call.
 * `resumes`: the hub tells the bot to go on right after.
 */
export function lastStepNote(resumes: boolean): ModelMessage {
  return {
    role: 'user',
    content: resumes
      ? '[Note du système] Tu as atteint le nombre maximum d’étapes pour ce tour : tu ne peux ' +
        'plus utiliser d’outils. Dis en une ou deux phrases où tu en es : tu reprendras ' +
        'automatiquement juste après, là où tu t’es arrêté.'
      : '[Note du système] Tu as atteint le nombre maximum d’étapes pour ce tour : tu ne peux ' +
        'plus utiliser d’outils. Résume en quelques lignes ce qui est fait et ce qui reste à ' +
        'faire. Tu pourras être relancé.',
  };
}

/** What the bot reads when the hub tells it to go on. */
export const RESUME_NOTE =
  '[Note du système] Reprise automatique : ton tour précédent s’est arrêté à la limite ' +
  'd’étapes. Continue là où tu t’es arrêté, sans refaire ni résumer ce qui est fait. Si le ' +
  'travail est fini ou que tu es bloqué, dis-le en une phrase et arrête-toi.';

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
