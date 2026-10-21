import type { Bot, Message, Team } from '@mowbot/contract';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AUTONOMOUS_STEPS,
  MAX_STEPS,
  RECENT_STEPS,
  SHORTENED,
} from '../src/agents/step-budget';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scriptedBy, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(model: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, () => model);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const send = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const transcript = async () =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
  return { inject, chef, send, transcript, services, runtime };
}

const count = (text: string, piece: string) => text.split(piece).length - 1;

/** A long log, opened by the command's marker. */
const longLog = (script: string) => {
  const marker = /echo (marqueur-\d+)/.exec(script)?.[1];
  return marker ? { stdout: `${marker}\n${'ligne de journal\n'.repeat(300)}` } : undefined;
};

/** Works with tools until told it has no step left, then sums up. */
const untilTheLimit = () =>
  scriptedBy((prompt, call) => {
    if (prompt.includes('"text":"Continue"')) return textTurn('Je reprends le rapport.');
    return prompt.includes('nombre maximum d’étapes')
      ? textTurn('Fait : les canvases sont listés. Reste : le rapport.')
      : toolTurn('canvas_list', {}, `call-${call}`);
  });

describe('the step limit', () => {
  it('ends the turn with a summary instead of a tool call, and marks the answer', async () => {
    const model = untilTheLimit();
    const { send, transcript } = await start(model);

    await send('Fais l’inventaire des canvases');

    expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
    // Tools are off at the last step only.
    expect(model.doStreamCalls.at(-2)?.toolChoice).toEqual({ type: 'auto' });
    expect(model.doStreamCalls.at(-1)?.toolChoice).toEqual({ type: 'none' });
    const answer = (await transcript()).at(-1);
    expect(answer).toMatchObject({ role: 'assistant', status: 'done', stepLimit: true });
    expect(answer?.parts.at(-1)).toEqual({
      type: 'text',
      text: 'Fait : les canvases sont listés. Reste : le rapport.',
    });

    // "Continue": the next turn picks up from the summary, and is not marked if it ends early.
    await send('Continue');
    expect(promptOf(model, MAX_STEPS)).toContain('Reste : le rapport.');
    expect((await transcript()).at(-1)).toMatchObject({
      status: 'done',
      stepLimit: false,
      parts: [{ type: 'text', text: 'Je reprends le rapport.' }],
    });
  });

  it('is lower when the bot works on its own', async () => {
    const model = untilTheLimit();
    const { inject, chef, services, transcript } = await start(model);
    const teams = (await inject<{ items: Team[] }>('GET', '/api/v1/teams')).body.items;
    const lea = await inject<Bot>('POST', '/api/v1/bots', {
      name: 'Léa',
      role: 'Recherche',
      teamId: teams[0]?.id,
    });

    await services.runtime.deliver(chef.id, {
      from: await services.bots.row(lea.body.id),
      kind: 'chat',
      text: 'Fais l’inventaire des canvases',
    });
    await services.runtime.settle();

    expect(model.doStreamCalls).toHaveLength(MAX_AUTONOMOUS_STEPS);
    expect((await transcript()).at(-1)).toMatchObject({ status: 'done', stepLimit: true });
  });

  it('leaves answers that finish in time unmarked', async () => {
    const model = scriptedBy((_prompt, call) =>
      call === 0 ? toolTurn('canvas_list', {}) : textTurn('Aucun canvas.'),
    );
    const { send, transcript } = await start(model);

    await send('Liste les canvases');

    expect((await transcript()).at(-1)).toMatchObject({ status: 'done', stepLimit: false });
  });
});

describe('old tool outputs', () => {
  it('reach later steps shortened, while the latest stay whole', async () => {
    const steps = RECENT_STEPS + 4;
    const model = scriptedBy((_prompt, call) =>
      call < steps
        ? toolTurn('bash', { command: `echo marqueur-${call}` }, `call-${call}`)
        : textTurn('Les journaux sont lus.'),
    );
    const { send, runtime, transcript } = await start(model);
    runtime.shell = longLog;

    await send('Lis les journaux');

    // Up to RECENT_STEPS results, nothing is cut.
    expect(promptOf(model, RECENT_STEPS)).not.toContain(SHORTENED);
    // At the end, the 4 oldest are cut to their first lines; the last ones are whole.
    const last = promptOf(model, steps);
    expect(count(last, SHORTENED)).toBe(4);
    expect(last).toContain('marqueur-0');
    expect(count(last, 'ligne de journal')).toBeGreaterThan(RECENT_STEPS * 300);
    expect(count(last, 'ligne de journal')).toBeLessThan((RECENT_STEPS + 1) * 300);

    // What the UI shows of each call is untouched.
    const first = (await transcript()).at(-1)?.parts[0];
    expect(first?.type === 'tool' && first.output).toContain('ligne de journal');
  });

  it('do not disturb messages steered in mid-answer', async () => {
    const steps = RECENT_STEPS + 3;
    let steer: (() => Promise<unknown>) | null = null;
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const n = call++;
        // The user writes again while the bot is busy with its first step.
        if (n === 0) await steer?.();
        const turn =
          n < steps
            ? toolTurn('bash', { command: `echo marqueur-${n}` }, `call-${n}`)
            : textTurn('C’est noté, pour le trail.');
        return { stream: simulateReadableStream({ chunks: turn }) };
      },
    });
    const { send, chef, services, runtime } = await start(model);
    steer = () => services.runtime.send(chef.id, 'En fait, plutôt pour le trail');
    runtime.shell = longLog;

    await send('Trouve-moi des chaussures');

    // Every later step reads it once, right after the first command.
    for (let n = 1; n <= steps; n++) {
      const prompt = promptOf(model, n);
      expect(count(prompt, 'plutôt pour le trail')).toBe(1);
      expect(prompt.indexOf('marqueur-0')).toBeLessThan(prompt.indexOf('plutôt pour le trail'));
      if (n > 1) {
        expect(prompt.indexOf('plutôt pour le trail')).toBeLessThan(prompt.indexOf('marqueur-1'));
      }
    }
    const last = promptOf(model, steps);
    expect(last).toContain('[Arrivé pendant que tu travaillais]\\nEn fait, plutôt pour le trail');
    expect(count(last, SHORTENED)).toBe(steps - RECENT_STEPS);
  });
});
