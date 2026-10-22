import type { Bot, Message, Team } from '@mowbot/contract';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_AUTONOMOUS_STEPS,
  MAX_RESUMES,
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

/** The last message of a prompt: what the model answers. */
const lastSaid = (prompt: string) => prompt.slice(prompt.lastIndexOf('"role":"user"'));

/**
 * Works with tools until told it has no step left, then sums up; told to go on, it finishes
 * (`stubborn`: it never does).
 */
const untilTheLimit = (stubborn = false) =>
  scriptedBy((prompt, call) => {
    const said = lastSaid(prompt);
    if (said.includes('nombre maximum d’étapes')) {
      return textTurn('Fait : les canvases sont listés. Reste : le rapport.');
    }
    if (!stubborn && said.includes('Reprise automatique')) {
      return textTurn('Je reprends le rapport.');
    }
    return toolTurn('canvas_list', {}, `call-${call}`);
  });

describe('the step limit', () => {
  it('ends the turn with a summary instead of a tool call, then goes on by itself', async () => {
    const model = untilTheLimit();
    const { send, transcript } = await start(model);

    await send('Fais l’inventaire des canvases');

    // Tools are off at the last step only; the bot knows it goes on right after.
    expect(model.doStreamCalls[MAX_STEPS - 2]?.toolChoice).toEqual({ type: 'auto' });
    expect(model.doStreamCalls[MAX_STEPS - 1]?.toolChoice).toEqual({ type: 'none' });
    expect(promptOf(model, MAX_STEPS - 1)).toContain('tu reprendras automatiquement');
    const said = await transcript();
    const cut = said.find((m) => m.stepLimit);
    const resume = said.find((m) => m.resume);
    const after = said.at(-1);
    expect(cut).toMatchObject({ role: 'assistant', status: 'done', stepLimit: true });
    expect(cut?.parts.at(-1)).toEqual({
      type: 'text',
      text: 'Fait : les canvases sont listés. Reste : le rapport.',
    });

    // The hub tells it to go on: a quiet line for the user, a note for the bot, who picks up
    // from its summary, on the user's behalf (not marked autonomous).
    expect(resume).toMatchObject({
      role: 'user',
      kind: 'chat',
      resume: 1,
      parts: [
        { type: 'text', text: `Reprise automatique après la limite d'étapes (1/${MAX_RESUMES})` },
      ],
    });
    expect(model.doStreamCalls).toHaveLength(MAX_STEPS + 1);
    expect(promptOf(model, MAX_STEPS)).toContain('Reste : le rapport.');
    expect(after).toMatchObject({
      status: 'done',
      stepLimit: false,
      autonomous: false,
      resume: null,
      parts: [{ type: 'text', text: 'Je reprends le rapport.' }],
    });
  });

  it('stays put while the bots are paused', async () => {
    const model = untilTheLimit();
    const { send, transcript, services } = await start(model);
    await services.system.update({ paused: true });

    await send('Fais l’inventaire des canvases');

    expect(model.doStreamCalls).toHaveLength(MAX_STEPS);
    expect((await transcript()).at(-1)).toMatchObject({ role: 'assistant', stepLimit: true });
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

    expect(model.doStreamCalls[MAX_AUTONOMOUS_STEPS - 1]?.toolChoice).toEqual({ type: 'none' });
    const said = await transcript();
    const cut = said.find((m) => m.stepLimit);
    const resume = said.find((m) => m.resume);
    const after = said.at(-1);
    expect(cut).toMatchObject({ status: 'done', stepLimit: true, autonomous: true });
    // It goes on on its own too.
    expect(resume).toMatchObject({ role: 'user', kind: 'routine', resume: 1 });
    expect(after).toMatchObject({ status: 'done', stepLimit: false, autonomous: true });
    expect(model.doStreamCalls).toHaveLength(MAX_AUTONOMOUS_STEPS + 1);
  });

  it('goes on at most MAX_RESUMES times, then tells the lead', async () => {
    const marcoModel = untilTheLimit(true);
    const leaModel = scriptedBy(() => textTurn('Je regarde ce qui bloque Marco.'));
    t = await createTestApp({}, undefined, (bot) =>
      bot.name === 'Marco' ? marcoModel : bot.name === 'Léa' ? leaModel : null,
    );
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const post = async <T>(url: string, payload: object) =>
      (await app.inject({ method: 'POST', url, headers: auth, payload })).json() as T;
    const conversation = async (botId: string) =>
      (
        await app.inject({ method: 'GET', url: `/api/v1/bots/${botId}/messages`, headers: auth })
      ).json().items as Message[];
    const team = await post<Team>('/api/v1/teams', { name: 'Agence web' });
    const lea = await post<Bot>('/api/v1/bots', {
      name: 'Léa',
      role: 'Cheffe de projet',
      teamId: team.id,
      lead: true,
    });
    const marco = await post<Bot>('/api/v1/bots', {
      name: 'Marco',
      role: 'Développeur',
      teamId: team.id,
    });

    await services.runtime.deliver(marco.id, {
      from: await services.bots.row(lea.id),
      kind: 'chat',
      text: 'Fais l’inventaire des canvases',
    });
    await services.runtime.settle();

    const turns = MAX_RESUMES + 1;
    expect(marcoModel.doStreamCalls).toHaveLength(turns * MAX_AUTONOMOUS_STEPS);
    // The last time, it knows nobody tells it to go on.
    expect(promptOf(marcoModel, turns * MAX_AUTONOMOUS_STEPS - 1)).toContain(
      'Tu pourras être relancé',
    );
    const marcos = await conversation(marco.id);
    expect(marcos.flatMap((m) => (m.resume ? [m.resume] : []))).toEqual([1, 2, 3, 4, 5]);
    expect(marcos.at(-1)).toMatchObject({ role: 'assistant', stepLimit: true });

    // Léa hears about it from the hub, and decides.
    const leas = await conversation(lea.id);
    expect(leas.at(-2)).toMatchObject({
      role: 'user',
      kind: 'routine',
      fromBotId: null,
      parts: [
        {
          type: 'text',
          text: `**Marco tourne en rond** · limite d'étapes atteinte ${turns} fois de suite`,
        },
      ],
    });
    expect(promptOf(leaModel, 0)).toContain(
      `[Note du hub] Marco (Développeur, équipe Agence web) a atteint la limite d'étapes ${turns} fois de suite`,
    );
    expect(leas.at(-1)).toMatchObject({ role: 'assistant', autonomous: true });
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
