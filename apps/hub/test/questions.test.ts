import type { Bot, Message, Notification, Question } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(chefModel: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, () => chefModel);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const say = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const open = async () =>
    (await inject<{ items: Question[] }>('GET', '/api/v1/questions')).body.items;
  const transcript = async () =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
  return { inject, chef, say, open, transcript, services };
}

const question = {
  question: 'Je réserve la table de 20 h ?',
  options: ['Oui', 'Non, 21 h', 'Oui'],
};

describe('questions to the user', () => {
  it('asks with answer buttons, and the answer comes back to the bot as a message', async () => {
    const model = scripted([
      toolTurn('ask_user', question),
      textTurn('Je te laisse choisir.'),
      textTurn('Parfait, je réserve pour 21 h.'),
    ]);
    const { inject, say, open, transcript } = await start(model);
    await say('Trouve un resto pour ce soir');

    const [asked] = await open();
    expect(asked).toMatchObject({ ...question, options: ['Oui', 'Non, 21 h'], status: 'open' });
    const notices = await inject<{ items: Notification[] }>('GET', '/api/v1/notifications');
    expect(notices.body.items[0]).toMatchObject({ body: question.question });

    const answered = await inject<Question>('POST', `/api/v1/questions/${asked?.id}/answer`, {
      answer: 'Non, 21 h',
    });
    expect(answered.body).toMatchObject({ status: 'answered', answer: 'Non, 21 h' });
    await t?.services.runtime.settle();

    expect(await open()).toEqual([]);
    // The app shows the answer; the bot reads which question it answers.
    const messages = await transcript();
    const reply = messages.find(
      (m) => m.role === 'user' && m.parts[0]?.type === 'text' && m.parts[0].text === 'Non, 21 h',
    );
    expect(reply).toBeDefined();
    expect(promptOf(model, 2)).toContain(
      '[Réponse à ta question « Je réserve la table de 20 h ? »]',
    );
    expect(messages.at(-1)?.parts).toContainEqual({
      type: 'text',
      text: 'Parfait, je réserve pour 21 h.',
    });

    const again = await inject('POST', `/api/v1/questions/${asked?.id}/answer`, { answer: 'Oui' });
    expect(again.status).toBe(409);
  });

  it('closes open questions when the user writes in the chat instead', async () => {
    const { say, open, inject } = await start(
      scripted([toolTurn('ask_user', question), textTurn('À toi.'), textTurn("D'accord.")]),
    );
    await say('Trouve un resto');
    expect(await open()).toHaveLength(1);
    await say('Laisse tomber, on mange à la maison');
    expect(await open()).toEqual([]);
    const all = await inject<{ items: Question[] }>('GET', '/api/v1/questions?status=all');
    expect(all.body.items[0]?.status).toBe('closed');
  });

  it('keeps a bot from piling up questions', async () => {
    const turns = [1, 2, 3, 4].map((n) =>
      toolTurn('ask_user', { question: `Question ${n} ?`, options: [] }, `call-${n}`),
    );
    const model = scripted([...turns, textTurn('Voilà.')]);
    const { say, open } = await start(model);
    await say('Pose-moi tes questions');
    expect(await open()).toHaveLength(3);
    expect(promptOf(model, 4)).toContain('déjà 3 questions sans réponse');
  });
});

describe('in the account language', () => {
  it('writes the notification in English for an English account', async () => {
    const { inject, say } = await start(
      scripted([
        toolTurn('ask_user', { question: 'Book for 8 pm?', options: ['Yes', 'No'] }),
        textTurn('Ok.'),
      ]),
    );
    await inject('PATCH', '/api/v1/me', { locale: 'en' });
    await say('Book a table');
    const notices = await inject<{ items: Notification[] }>('GET', '/api/v1/notifications');
    expect(notices.body.items[0]).toMatchObject({ title: 'Chef has a question for you' });
  });
});
