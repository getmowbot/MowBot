import type {
  Bot,
  Message,
  Notification,
  Routine,
  RoutineRun,
  ServerEvent,
} from '@mowbot/contract';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { messages, routines } from '../src/db/schema';
import { inQuietHours, nextRun, startOfDay, triggerProblem } from '../src/proactivity/schedule';
import { bearer, createTestApp, setupOwner } from './helpers';
import { scripted, textTurn, toolTurn } from './models';

const TZ = 'Europe/Paris';

describe('schedules', () => {
  const from = new Date('2026-10-20T10:00:00Z'); // 12:00 in Paris

  it('computes the next run of each trigger', () => {
    expect(nextRun({ type: 'cron', expr: '30 13 * * *' }, from, TZ)?.toISOString()).toBe(
      '2026-10-20T11:30:00.000Z',
    );
    expect(nextRun({ type: 'interval', minutes: 15 }, from, TZ)?.toISOString()).toBe(
      '2026-10-20T10:15:00.000Z',
    );
    expect(nextRun({ type: 'once', at: '2026-10-19T10:00:00Z' }, from, TZ)).toBeNull();
    expect(nextRun({ type: 'webhook' }, from, TZ)).toBeNull();
  });

  it('refuses invalid or too frequent triggers', () => {
    expect(triggerProblem({ type: 'cron', expr: '* * * * *' }, from, TZ)).toMatch(/5 minutes/);
    expect(triggerProblem({ type: 'cron', expr: 'tous les jours' }, from, TZ)).toMatch(/invalide/);
    expect(triggerProblem({ type: 'once', at: '2026-01-01T00:00:00Z' }, from, TZ)).toMatch(/futur/);
    expect(triggerProblem({ type: 'cron', expr: '0 8 * * 1-5' }, from, TZ)).toBeNull();
  });

  it('knows quiet hours (across midnight) and the start of the day, in the time zone', () => {
    const quiet = { start: '22:00', end: '07:00' };
    expect(inQuietHours(quiet, new Date('2026-10-20T21:30:00Z'), TZ)).toBe(true); // 23:30
    expect(inQuietHours(quiet, new Date('2026-10-20T04:00:00Z'), TZ)).toBe(true); // 06:00
    expect(inQuietHours(quiet, from, TZ)).toBe(false);
    expect(inQuietHours(null, from, TZ)).toBe(false);
    expect(startOfDay(from, TZ).toISOString()).toBe('2026-10-19T22:00:00.000Z');
  });
});

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A hub whose bots answer with the model (or model chain) registered under their name. */
async function start(models: Record<string, MockLanguageModelV4 | MockLanguageModelV4[]> = {}) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({ method, url, headers: auth, payload: payload as object });
    return { status: res.statusCode, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const events: ServerEvent[] = [];
  services.events.subscribe((event) => events.push(event));
  const conversation = async (botId: string) =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${botId}/messages`)).body.items;
  /** Makes a routine due now and lets the scheduler and the bots do their work. */
  const fireDue = async (routineId: string) => {
    await services.db
      .update(routines)
      .set({ nextRunAt: new Date(Date.now() - 1000) })
      .where(eq(routines.id, routineId));
    await services.scheduler.tick();
    await services.runtime.settle();
  };
  const runs = async (routineId: string) =>
    (await inject<{ items: RoutineRun[] }>('GET', `/api/v1/routines/${routineId}/runs`)).body.items;
  return { app, services, auth, inject, chef, events, conversation, fireDue, runs };
}

const failing = () =>
  new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('provider down');
    },
  });

describe('routines', () => {
  it('gives the Chef a daily summary', async () => {
    const { inject, chef } = await start();
    const { body } = await inject<{ items: Routine[] }>('GET', `/api/v1/routines?botId=${chef.id}`);
    expect(body.items).toEqual([
      expect.objectContaining({ kind: 'digest', trigger: { type: 'cron', expr: '0 19 * * *' } }),
    ]);
  });

  it('lets a bot create a routine on its own, then runs it when due', async () => {
    const chefModel = scripted([
      toolTurn('create_routine', {
        name: 'Veille IA',
        instruction: 'Résume les nouveautés IA du jour.',
        trigger: { cron: '0 9 * * *' },
      }),
      textTurn('Je ferai une veille chaque matin.'),
      textTurn('Trois annonces aujourd’hui.'),
    ]);
    const { services, inject, chef, conversation, fireDue, runs } = await start({
      Chef: chefModel,
    });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, {
      text: 'Tiens-moi au courant de l’IA',
    });
    await services.runtime.settle();

    const mine = (
      await inject<{ items: Routine[] }>('GET', `/api/v1/routines?botId=${chef.id}`)
    ).body.items.find((r) => r.kind === 'custom');
    expect(mine).toMatchObject({
      name: 'Veille IA',
      createdBy: 'bot',
      silent: true,
      enabled: true,
    });
    expect(mine?.nextRunAt).toBeTruthy();

    await fireDue(mine?.id as string);
    const [run] = await runs(mine?.id as string);
    expect(run).toMatchObject({ status: 'done' });
    const fired = (await conversation(chef.id)).find((m) => m.kind === 'routine');
    expect(fired?.parts[0]).toMatchObject({ text: '**Veille IA**' });
    expect(JSON.stringify(chefModel.doStreamCalls[2]?.prompt)).toContain('[Routine « Veille IA »]');
  });

  it('validates routines set up by the user, and lets them switch one off', async () => {
    const { inject, chef } = await start();
    const bad = await inject('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Trop souvent',
      prompt: 'x',
      trigger: { type: 'cron', expr: '* * * * *' },
    });
    expect(bad.status).toBe(400);
    const created = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Rappel',
      prompt: 'Rappelle-moi de sortir le chien.',
      trigger: { type: 'interval', minutes: 60 },
    });
    expect(created.status).toBe(201);
    expect(created.body.createdBy).toBe('user');
    const off = await inject<Routine>('PATCH', `/api/v1/routines/${created.body.id}`, {
      enabled: false,
    });
    expect(off.body.enabled).toBe(false);
    expect((await inject('DELETE', `/api/v1/routines/${created.body.id}`)).status).toBe(204);
  });

  it('switches a routine off after repeated failures and tells the user', async () => {
    const { inject, chef, fireDue, services } = await start({ Chef: failing() });
    const { body: routine } = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Fragile',
      prompt: 'Fais quelque chose.',
      trigger: { type: 'interval', minutes: 30 },
    });
    for (let i = 0; i < 3; i++) await fireDue(routine.id);
    const [row] = await services.db.select().from(routines).where(eq(routines.id, routine.id));
    expect(row).toMatchObject({ enabled: false, failures: 3, lastStatus: 'error' });
    const { body } = await inject<{ items: Notification[]; unread: number }>(
      'GET',
      '/api/v1/notifications',
    );
    expect(body.items[0]?.title).toContain('Fragile');
    expect(body.unread).toBe(1);
  });

  it('tells the user what a non-silent routine found', async () => {
    const { inject, chef, fireDue } = await start({
      Chef: scripted([textTurn('Le site est en ligne.')]),
    });
    const { body: routine } = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Vérifier le site',
      prompt: 'Vérifie que le site répond.',
      trigger: { type: 'interval', minutes: 60 },
      silent: false,
    });
    await fireDue(routine.id);
    const { body } = await inject<{ items: Notification[] }>('GET', '/api/v1/notifications');
    expect(body.items[0]).toMatchObject({
      title: 'Vérifier le site',
      body: 'Le site est en ligne.',
    });
  });

  it('fires webhook routines with what was posted, and only with the right secret', async () => {
    const chefModel = scripted([textTurn('Commande notée.')]);
    const { app, inject, chef, services } = await start({ Chef: chefModel });
    const { body: routine } = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Nouvelle commande',
      prompt: 'Une commande est arrivée : prépare le bon de livraison.',
      trigger: { type: 'webhook' },
    });
    expect(routine.webhookUrl).toMatch(/^\/api\/v1\/hooks\/routines\/.+\/.+$/);
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/hooks/routines/${routine.id}/nope`,
      payload: { order: 42 },
    });
    expect(wrong.statusCode).toBe(404);
    const hook = await app.inject({
      method: 'POST',
      url: routine.webhookUrl as string,
      payload: { order: 42 },
    });
    expect(hook.json()).toEqual({ accepted: true });
    await services.runtime.settle();
    const prompt = JSON.stringify(chefModel.doStreamCalls[0]?.prompt);
    expect(prompt).toContain('Données reçues par le webhook');
    expect(prompt).toContain('\\"order\\": 42');
  });
});

describe('check-ins', () => {
  it('leaves no trace when there is nothing to do', async () => {
    const { inject, chef, fireDue, conversation, runs, events } = await start({
      Chef: scripted([textTurn('RAS')]),
    });
    await inject('PATCH', '/api/v1/system', { quietHours: null });
    await inject('PATCH', `/api/v1/bots/${chef.id}`, { heartbeatMinutes: 30 });
    const heartbeat = (
      await inject<{ items: Routine[] }>('GET', `/api/v1/routines?botId=${chef.id}`)
    ).body.items.find((r) => r.kind === 'heartbeat');
    expect(heartbeat?.trigger).toEqual({ type: 'interval', minutes: 30 });

    await fireDue(heartbeat?.id as string);
    expect(await conversation(chef.id)).toEqual([]);
    expect((await runs(heartbeat?.id as string))[0]).toMatchObject({
      status: 'idle',
      messageId: null,
    });
    expect(events.filter((e) => e.type === 'message.deleted')).toHaveLength(2);

    await inject('PATCH', `/api/v1/bots/${chef.id}`, { heartbeatMinutes: null });
    const left = (await inject<{ items: Routine[] }>('GET', `/api/v1/routines?botId=${chef.id}`))
      .body.items;
    expect(left.some((r) => r.kind === 'heartbeat')).toBe(false);
  });

  it('wait out quiet hours', async () => {
    const { inject, chef, fireDue, runs } = await start({ Chef: scripted([textTurn('RAS')]) });
    await inject('PATCH', '/api/v1/system', { quietHours: { start: '00:00', end: '23:59' } });
    await inject('PATCH', `/api/v1/bots/${chef.id}`, { heartbeatMinutes: 30 });
    const heartbeat = (
      await inject<{ items: Routine[] }>('GET', `/api/v1/routines?botId=${chef.id}`)
    ).body.items.find((r) => r.kind === 'heartbeat');
    await fireDue(heartbeat?.id as string);
    expect((await runs(heartbeat?.id as string))[0]).toMatchObject({
      status: 'skipped',
      detail: 'Heures calmes',
    });
  });
});

describe('limits', () => {
  it('stops what a bot does on its own once its daily budget is spent', async () => {
    const { inject, chef, fireDue, runs, services } = await start({
      Chef: scripted([textTurn('Ok.')]),
    });
    await inject('PATCH', `/api/v1/bots/${chef.id}`, { dailyTokenBudget: 1000 });
    await services.db.insert(messages).values({
      botId: chef.id,
      role: 'assistant',
      parts: [],
      modelMessages: [],
      status: 'done',
      usage: { inputTokens: 900, outputTokens: 200 },
      meta: { autonomous: true },
    });
    const { body: routine } = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Coûteuse',
      prompt: 'x',
      trigger: { type: 'interval', minutes: 30 },
    });
    await fireDue(routine.id);
    expect((await runs(routine.id))[0]).toMatchObject({ status: 'skipped' });
    const { body } = await inject<{ items: Notification[] }>('GET', '/api/v1/notifications');
    expect(body.items[0]?.title).toContain('budget');
  });

  it('pauses everything bots do on their own, and picks it up on resume', async () => {
    const { inject, chef, fireDue, runs, services, conversation } = await start({
      Chef: scripted([textTurn('Fait.')]),
    });
    const { body: routine } = await inject<Routine>('POST', '/api/v1/routines', {
      botId: chef.id,
      name: 'Pendant la pause',
      prompt: 'x',
      trigger: { type: 'interval', minutes: 30 },
    });
    await inject('PATCH', '/api/v1/system', { paused: true });
    await fireDue(routine.id);
    expect(await runs(routine.id)).toEqual([]);

    // A routine fired by hand still reaches the bot, which waits for the resume.
    await inject('POST', `/api/v1/routines/${routine.id}/run`);
    await services.runtime.settle();
    expect((await conversation(chef.id)).map((m) => m.role)).toEqual(['user']);

    await inject('PATCH', '/api/v1/system', { paused: false });
    await services.runtime.settle();
    expect((await conversation(chef.id)).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('falls back to the next model when one fails', async () => {
    const { inject, chef, conversation, services } = await start({
      Chef: [failing(), scripted([textTurn('Réponse du secours.')])],
    });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Bonjour' });
    await services.runtime.settle();
    const answer = (await conversation(chef.id))[1];
    expect(answer).toMatchObject({
      status: 'done',
      parts: [{ type: 'text', text: 'Réponse du secours.' }],
    });
  });
});

describe('notifications', () => {
  it('lets bots notify the user, who can mark them read', async () => {
    const { inject, chef, services } = await start({
      Chef: scripted([
        toolTurn('notify_user', {
          title: 'Colis livré',
          body: 'Devant la porte.',
          priority: 'urgent',
        }),
        toolTurn('notify_user', { title: 'Petite info', priority: 'digest' }, 'call-2'),
        textTurn('Je t’ai prévenu.'),
      ]),
    });
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text: 'Préviens-moi' });
    await services.runtime.settle();
    let list = (
      await inject<{ items: Notification[]; unread: number }>('GET', '/api/v1/notifications')
    ).body;
    expect(list.items.map((n) => n.priority)).toEqual(['digest', 'urgent']);
    expect(list.unread).toBe(1);
    await inject('POST', '/api/v1/notifications/read', {});
    list = (await inject<{ items: Notification[]; unread: number }>('GET', '/api/v1/notifications'))
      .body;
    expect(list.unread).toBe(0);
  });
});
