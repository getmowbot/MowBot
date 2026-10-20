import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

export type Turn = LanguageModelV4StreamPart[];

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

export const textTurn = (text: string): Turn => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...text.split(' ').map((word, i) => ({
    type: 'text-delta' as const,
    id: 't',
    delta: i === 0 ? word : ` ${word}`,
  })),
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];

export const toolTurn = (toolName: string, input: unknown, id = 'call-1'): Turn => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
];

/** A model that plays the given turns in order (the last one repeats). */
export function scripted(turns: Turn[], chunkDelayInMs = 0) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: turns[Math.min(call++, turns.length - 1)] ?? [],
        chunkDelayInMs,
      }),
    }),
  });
}

/** A model whose turn depends on what it reads (the prompt as JSON) and on its call count. */
export function scriptedBy(play: (prompt: string, call: number) => Turn) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => ({
      stream: simulateReadableStream({ chunks: play(JSON.stringify(prompt), call++) }),
    }),
  });
}

/** Everything the model was shown at its n-th call. */
export const promptOf = (model: MockLanguageModelV4, call: number) =>
  JSON.stringify(model.doStreamCalls[call]?.prompt ?? null);
