import type { Bot, Message, ServerEvent, Task, Team, TeamPlan } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpProblem } from '../src/http/problems';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, scriptedBy, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TASK_ID = /\(id ([0-9a-f-]{36})\)/;

/** A hub with an « Agence web » team led by Léa, with Marco and Sacha. */
async function start(models: Record<string, MockLanguageModelV4> = {}, lead = true) {
  t = await createTestApp({}, undefined, (bot) => models[bot.name] ?? null);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const get = async <T>(url: string): Promise<T> =>
    (await app.inject({ method: 'GET', url, headers: auth })).json();
  const chef = (await get<{ items: Bot[] }>('/api/v1/bots')).items[0] as Bot;
  const main = (await get<{ items: Team[] }>('/api/v1/teams')).items[0] as Team;
  const team: Team = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: auth,
      payload: { name: 'Agence web', mission: 'Des sites pour nos clients' },
    })
  ).json();
  const createBot = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots',
      headers: auth,
      payload: { role: 'Développeur', teamId: team.id, ...body },
    });
    if (res.statusCode !== 201) throw new Error(`createBot ${res.statusCode} ${res.body}`);
    return res.json() as Bot;
  };
  const lea = await createBot({ name: 'Léa', role: 'Cheffe de projet', lead });
  const marco = await createBot({ name: 'Marco' });
  const sacha = await createBot({ name: 'Sacha' });
  const events: ServerEvent[] = [];
  services.events.subscribe((event) => events.push(event));
  const row = (id: string) => services.bots.row(id);
  const say = async (botId: string, text: string) => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${botId}/messages`,
      headers: auth,
      payload: { text },
    });
    await services.runtime.settle();
  };
  const plan = async () =>
    (await get<{ plan: TeamPlan | null }>(`/api/v1/teams/${team.id}/plan`)).plan;
  const conversation = (botId: string) =>
    get<{ items: Message[] }>(`/api/v1/bots/${botId}/messages`).then((r) => r.items);
  return {
    app,
    services,
    auth,
    get,
    chef,
    main,
    team,
    lea,
    marco,
    sacha,
    events,
    row,
    say,
    plan,
    conversation,
  };
}

const rejection = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as HttpProblem | null;
  return error ? { status: error.status, code: error.code } : null;
};

describe('team plans', () => {
  it('has the lead write the plan, delegate its steps, and the steps follow their tasks', async () => {
    const marcoModel = scriptedBy((prompt, call) =>
      call === 0
        ? toolTurn('update_task', { id: TASK_ID.exec(prompt)?.[1], status: 'doing' })
        : call === 1
          ? toolTurn(
              'update_task',
              { id: TASK_ID.exec(prompt)?.[1], status: 'done', result: 'index.html' },
              'call-2',
            )
          : textTurn('Fini.'),
    );
    const { lea, marco, plan, say, events, get, team } = await start({
      Léa: scripted([
        toolTurn('plan_set', {
          goal: 'Refaire le site de la boulangerie',
          steps: [
            { title: 'Maquettes', owner: 'Léa' },
            { title: "Page d'accueil", owner: 'Sacha' },
            { title: 'Mise en ligne' },
          ],
        }),
        toolTurn('assign_task', { to: 'Marco', title: "Page d'accueil", step: 2 }, 'call-2'),
        textTurn('Plan écrit, Marco est sur la page d’accueil.'),
      ]),
      Marco: marcoModel,
    });
    expect(await plan()).toBeNull();

    await say(lea.id, 'On refait le site de la boulangerie');

    const { items: tasks } = await get<{ items: Task[] }>('/api/v1/tasks');
    const task = tasks.find((x) => x.title === "Page d'accueil");
    expect(task).toMatchObject({ assigneeBotId: marco.id, status: 'done' });
    const written = await plan();
    expect(written).toMatchObject({
      teamId: team.id,
      goal: 'Refaire le site de la boulangerie',
      authorBotId: lea.id,
      projectId: null,
    });
    // The step went to Marco with the task, and followed it to the end.
    expect(
      written?.steps.map(({ title, status, ownerBotId, taskId }) => ({
        title,
        status,
        ownerBotId,
        taskId,
      })),
    ).toEqual([
      { title: 'Maquettes', status: 'todo', ownerBotId: lea.id, taskId: null },
      { title: "Page d'accueil", status: 'done', ownerBotId: marco.id, taskId: task?.id },
      { title: 'Mise en ligne', status: 'todo', ownerBotId: null, taskId: null },
    ]);
    const statuses = events.flatMap((e) =>
      e.type === 'plan.updated' ? [e.plan?.steps[1]?.status] : [],
    );
    expect(statuses).toEqual(['todo', 'todo', 'doing', 'done']);

    // Marco read the plan, the step as his, before he started.
    const first = promptOf(marcoModel, 0);
    expect(first).toContain("Plan de l'équipe Agence web :");
    expect(first).toContain('Objectif : Refaire le site de la boulangerie');
    expect(first).toContain("2. [à faire] Page d'accueil — Marco (toi) · suit sa tâche");
    expect(first).toContain('Avancement : 0/3.');
    expect(first).toContain('Une étape à toi');
  });

  it('keeps the plan to its lead and the Chef; members mark their own steps', async () => {
    const { services, team, lea, marco, sacha, chef, row, main } = await start();
    const plans = services.plans;
    const leaRow = await row(lea.id);
    const marcoRow = await row(marco.id);
    const sachaRow = await row(sacha.id);
    const chefRow = await row(chef.id);
    const steps = [
      { title: 'Maquettes', ownerBotId: lea.id },
      { title: 'Intégration', ownerBotId: marco.id },
    ];
    expect(await rejection(plans.set(team.id, { goal: 'Le site', steps }, marcoRow))).toEqual({
      status: 403,
      code: 'not_plan_keeper',
    });
    await plans.set(team.id, { goal: 'Le site', steps }, leaRow);

    // Marco marks his own step, not Léa's, and changes nothing else.
    const marked = await plans.update(team.id, { steps: [{ step: 2, status: 'doing' }] }, marcoRow);
    expect(marked.steps[1]?.status).toBe('doing');
    expect(
      await rejection(plans.update(team.id, { steps: [{ step: 1, status: 'done' }] }, marcoRow)),
    ).toEqual({ status: 403, code: 'not_your_step' });
    expect(
      await rejection(
        plans.update(team.id, { steps: [{ step: 2, title: 'Tout le site' }] }, marcoRow),
      ),
    ).toEqual({ status: 403, code: 'not_plan_keeper' });
    expect(await rejection(plans.update(team.id, { add: [{ title: 'SEO' }] }, sachaRow))).toEqual({
      status: 403,
      code: 'not_plan_keeper',
    });
    expect(
      await rejection(plans.update(team.id, { steps: [{ step: 9, status: 'done' }] }, leaRow)),
    ).toEqual({ status: 400, code: 'no_such_step' });

    // The Chef keeps any team's plan.
    const chefs = await plans.update(team.id, { goal: 'Le site, en ligne vendredi' }, chefRow);
    expect(chefs.goal).toBe('Le site, en ligne vendredi');

    // A step that carries a task follows it: a bot moves the task, not the step.
    const task = await services.tasks.create(
      { assignee: sachaRow, title: 'Maquettes', step: { teamId: team.id, number: 1 } },
      leaRow,
    );
    expect(
      await rejection(plans.update(team.id, { steps: [{ step: 1, status: 'done' }] }, sachaRow)),
    ).toEqual({ status: 409, code: 'step_follows_task' });
    // Unless it lets go of it.
    const loose = await plans.update(
      team.id,
      { steps: [{ step: 1, status: 'done', taskId: null }] },
      leaRow,
    );
    expect(loose.steps[0]).toMatchObject({ status: 'done', taskId: null, ownerBotId: sacha.id });
    expect(task.assigneeBotId).toBe(sacha.id);

    // A team without a plan has nothing to update.
    expect(await rejection(plans.update(main.id, { goal: 'x' }, chefRow))).toEqual({
      status: 404,
      code: 'no_plan',
    });
  });

  it('only gives plan_set to leads and the Chef, and step to them in assign_task', async () => {
    const marcoModel = scripted([
      toolTurn('assign_task', { to: 'Sacha', title: 'Les photos', step: 1 }),
      toolTurn('plan_update', { steps: [{ step: 1, status: 'doing' }] }, 'call-2'),
      textTurn('Je m’y mets.'),
    ]);
    const { services, team, lea, marco, row, say, plan, conversation } = await start({
      Marco: marcoModel,
      Sacha: scripted([textTurn('Ok.')]),
    });
    await services.plans.set(
      team.id,
      { goal: 'Le site', steps: [{ title: 'Photos', ownerBotId: marco.id }] },
      await row(lea.id),
    );
    await say(marco.id, 'Occupe-toi des photos');

    const tools = (marcoModel.doStreamCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['plan_show', 'plan_update']));
    expect(tools).not.toContain('plan_set');
    const answer = (await conversation(marco.id)).at(-1);
    const calls = answer?.parts.filter((p) => p.type === 'tool');
    expect(calls?.[0]).toMatchObject({ toolName: 'assign_task', state: 'error' });
    expect(calls?.[1]).toMatchObject({ toolName: 'plan_update', state: 'done' });
    expect((await plan())?.steps[0]).toMatchObject({ status: 'doing', taskId: null });
  });

  it('lets go of a step when its task is cancelled, and keeps it done when the task is cleared', async () => {
    const { services, team, lea, sacha, row, plan } = await start();
    const leaRow = await row(lea.id);
    const sachaRow = await row(sacha.id);
    await services.plans.set(
      team.id,
      { goal: 'Le site', steps: [{ title: 'Logo' }, { title: 'Textes' }] },
      leaRow,
    );
    const logo = await services.tasks.create(
      { assignee: sachaRow, title: 'Logo', step: { teamId: team.id, number: 1 } },
      leaRow,
    );
    const texts = await services.tasks.create(
      { assignee: sachaRow, title: 'Textes', step: { teamId: team.id, number: 2 } },
      leaRow,
    );
    await services.runtime.settle();
    await services.tasks.update(logo.id, { status: 'blocked' }, sachaRow);
    expect((await plan())?.steps[0]).toMatchObject({ status: 'blocked', taskId: logo.id });
    await services.tasks.update(logo.id, { status: 'cancelled' }, leaRow);
    expect((await plan())?.steps[0]).toMatchObject({
      status: 'todo',
      taskId: null,
      ownerBotId: sacha.id,
    });

    await services.tasks.update(texts.id, { status: 'done', result: 'ok' }, sachaRow);
    await services.tasks.clearActivity();
    expect((await plan())?.steps[1]).toMatchObject({ status: 'done', taskId: null });

    // A step number that does not exist refuses the task before it is made.
    expect(
      await rejection(
        services.tasks.create(
          { assignee: sachaRow, title: 'SEO', step: { teamId: team.id, number: 3 } },
          leaRow,
        ),
      ),
    ).toEqual({ status: 400, code: 'no_such_step' });
    expect((await services.tasks.list()).map((x) => x.title)).not.toContain('SEO');
  });

  it('adds, removes and renames steps by their numbers, and keeps them when rewritten', async () => {
    const { services, team, lea, marco, row } = await start();
    const leaRow = await row(lea.id);
    const plans = services.plans;
    await plans.set(
      team.id,
      { goal: 'Le site', steps: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
      leaRow,
    );
    const edited = await plans.update(
      team.id,
      {
        steps: [
          { step: 1, remove: true },
          { step: 3, title: 'C bis', ownerBotId: marco.id, status: 'doing' },
        ],
        add: [{ title: 'Avant tout', after: 0 }, { title: 'Après B', after: 2 }, { title: 'Fin' }],
      },
      leaRow,
    );
    expect(edited.steps.map((s) => s.title)).toEqual([
      'Avant tout',
      'B',
      'Après B',
      'C bis',
      'Fin',
    ]);
    expect(edited.steps[3]).toMatchObject({ ownerBotId: marco.id, status: 'doing' });

    // Rewritten: a step with the same title keeps its owner and status.
    const ids = new Map(edited.steps.map((s) => [s.title, s.id]));
    const rewritten = await plans.set(
      team.id,
      { goal: 'Le site, v2', steps: [{ title: 'c BIS' }, { title: 'Nouveau' }] },
      leaRow,
    );
    expect(rewritten.steps).toMatchObject([
      { title: 'c BIS', ownerBotId: marco.id, status: 'doing', id: ids.get('C bis') },
      { title: 'Nouveau', ownerBotId: null, status: 'todo' },
    ]);
    expect(await plans.text(rewritten, marco.id)).toBe(
      [
        'Objectif : Le site, v2',
        '1. [en cours] c BIS — Marco (toi)',
        '2. [à faire] Nouveau',
        'Avancement : 0/2.',
      ].join('\n'),
    );
  });

  it('lets the user read, write and clear a plan', async () => {
    const { app, auth, team, marco, plan, events, main } = await start();
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/plan`,
      headers: auth,
      payload: {
        goal: 'Une boutique en ligne',
        steps: [
          { title: 'Catalogue', ownerBotId: marco.id, status: 'doing' },
          { title: 'Paiement' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ authorBotId: null, goal: 'Une boutique en ligne' });
    expect((await plan())?.steps).toHaveLength(2);
    expect(events).toContainEqual({ type: 'plan.updated', teamId: team.id, plan: put.json() });

    const unknown = await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${team.id}/plan`,
      headers: auth,
      payload: { goal: 'x', steps: [{ title: 'y', ownerBotId: main.id }] },
    });
    expect(unknown.statusCode).toBe(400);

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${team.id}/plan`,
      headers: auth,
    });
    expect(cleared.statusCode).toBe(204);
    expect(await plan()).toBeNull();
    expect(events.at(-1)).toEqual({ type: 'plan.updated', teamId: team.id, plan: null });
  });

  it('goes with the team when it starts over or is deleted', async () => {
    const { app, auth, services, team, lea, row, plan, events } = await start();
    const leaRow = await row(lea.id);
    await services.plans.set(team.id, { goal: 'Projet 1', steps: [{ title: 'A' }] }, leaRow);
    // Clearing a few bots leaves it.
    await services.runtime.clear(lea.id);
    expect(await plan()).not.toBeNull();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${team.id}/messages`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(await plan()).toBeNull();
    expect(events).toContainEqual({ type: 'plan.updated', teamId: team.id, plan: null });

    await services.plans.set(team.id, { goal: 'Projet 2', steps: [{ title: 'B' }] }, leaRow);
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${team.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(204);
    expect(await services.plans.all()).toEqual([]);
  });

  it('shows the Chef every plan: those it keeps in full, the others in a line', async () => {
    const chefModel = scripted([
      toolTurn('plan_show', { team: 'Agence web' }),
      textTurn('La page d’accueil est en cours.'),
    ]);
    const { services, team, lea, chef, row, say, conversation } = await start({ Chef: chefModel });
    await services.plans.set(
      team.id,
      {
        goal: 'Refaire le site',
        steps: [
          { title: 'Maquettes', status: 'done', ownerBotId: lea.id },
          { title: 'Intégration', status: 'blocked' },
          { title: 'Mise en ligne' },
        ],
      },
      await row(lea.id),
    );
    await say(chef.id, 'Où en est le site ?');
    const prompt = promptOf(chefModel, 0);
    expect(prompt).toContain("## Le plan d'attaque");
    expect(prompt).toContain('- Agence web : Refaire le site — 1/3, 1 bloquée');
    expect(prompt).toContain("Si l'utilisateur demande où vous en êtes");
    expect(prompt).not.toContain('1. [fait] Maquettes');
    const call = (await conversation(chef.id)).at(-1)?.parts.find((p) => p.type === 'tool');
    expect(call?.type === 'tool' && call.output).toContain('1. [fait] Maquettes — Léa');
  });

  it('has the Chef keep the plan of a team without a lead', async () => {
    const chefModel = scripted([textTurn('Ok.')]);
    const marcoModel = scripted([textTurn('Ok.')]);
    const { services, team, chef, marco, row, say } = await start(
      { Chef: chefModel, Marco: marcoModel },
      false,
    );
    await services.plans.set(
      team.id,
      { goal: 'Refaire le site', steps: [{ title: 'Intégration', ownerBotId: marco.id }] },
      await row(chef.id),
    );
    await say(chef.id, 'Bonjour');
    expect(promptOf(chefModel, 0)).toContain('1. [à faire] Intégration — Marco');
    await say(marco.id, 'Bonjour');
    const prompt = promptOf(marcoModel, 0);
    expect(prompt).toContain('1. [à faire] Intégration — Marco (toi)');
    // A member does not get the keeper's instructions.
    expect(prompt).not.toContain("écris d'abord son plan avec plan_set");
  });
});
