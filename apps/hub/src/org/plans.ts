import {
  PLAN_MAX_STEPS,
  type PlanStepStatus,
  type TaskStatus,
  type TeamPlan,
  type TeamPlanInput,
} from '@mowbot/contract';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bots, planSteps, projects, tasks, teamPlans, teams } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem, notFound } from '../http/problems';

type PlanRow = typeof teamPlans.$inferSelect;
type StepRow = typeof planSteps.$inferSelect;
type BotRow = typeof bots.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export function toPlan(row: PlanRow, steps: StepRow[]): TeamPlan {
  return {
    teamId: row.teamId,
    goal: row.goal,
    projectId: row.projectId,
    authorBotId: row.authorBotId,
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      ownerBotId: step.ownerBotId,
      taskId: step.taskId,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** How a task shows on the step it carries; a cancelled task lets go of its step. */
const FROM_TASK: Record<TaskStatus, PlanStepStatus> = {
  todo: 'todo',
  doing: 'doing',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'todo',
};

export const PLAN_STATUS_LABELS: Record<PlanStepStatus, string> = {
  todo: 'à faire',
  doing: 'en cours',
  done: 'fait',
  blocked: 'bloqué',
};

/** A change to one step, by its number (1 = the first, as the plan was before the change). */
export interface StepEdit {
  step: number;
  title?: string;
  status?: PlanStepStatus;
  /** null: nobody. */
  ownerBotId?: string | null;
  /** null: the step lets go of its task. */
  taskId?: string | null;
  remove?: boolean;
}

/** What `update` changes; a member that does not keep the plan only marks its own steps. */
export interface PlanEdit {
  goal?: string;
  projectId?: string | null;
  steps?: StepEdit[];
  /** New steps, after the step numbered `after` (0: first; by default, at the end). */
  add?: { title: string; status?: PlanStepStatus; ownerBotId?: string | null; after?: number }[];
}

type StepValues = Omit<typeof planSteps.$inferInsert, 'teamId' | 'position'>;

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const tooManySteps = () =>
  new HttpProblem(
    400,
    'too_many_steps',
    `Un plan compte ${PLAN_MAX_STEPS} étapes au plus : regroupe-les.`,
  );

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

const notKeeper = () =>
  new HttpProblem(
    403,
    'not_plan_keeper',
    "Seuls le lead de l'équipe et le Chef tiennent son plan ; toi, tu marques tes propres étapes.",
  );

/**
 * Each team's plan of attack: a goal, then ordered steps with their owner and status. Its lead
 * or the Chef writes it (the user too); a member marks the steps it owns; a step that carries a
 * task follows it. Changes are published as `plan.updated`.
 */
export class PlanService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  async get(teamId: string): Promise<TeamPlan | null> {
    const [row] = await this.db.select().from(teamPlans).where(eq(teamPlans.teamId, teamId));
    return row ? toPlan(row, await this.steps(teamId)) : null;
  }

  /** Every team's plan (the Chef's overview). */
  async all(): Promise<TeamPlan[]> {
    const rows = await this.db.select().from(teamPlans);
    if (rows.length === 0) return [];
    const steps = await this.db
      .select()
      .from(planSteps)
      .where(
        inArray(
          planSteps.teamId,
          rows.map((row) => row.teamId),
        ),
      )
      .orderBy(asc(planSteps.position));
    return rows.map((row) =>
      toPlan(
        row,
        steps.filter((step) => step.teamId === row.teamId),
      ),
    );
  }

  /** Who writes a team's plan and changes any step: the user (null), the Chef, the team's lead. */
  async keeps(teamId: string, actor: BotRow | null): Promise<boolean> {
    if (!actor || actor.isChef) return true;
    const [team] = await this.db
      .select({ leadBotId: teams.leadBotId })
      .from(teams)
      .where(eq(teams.id, teamId));
    return team?.leadBotId === actor.id;
  }

  /**
   * Writes the plan over. A step titled as before keeps what it does not say again (its owner,
   * its status, its task): rewriting a plan halfway does not lose where it stood.
   */
  async set(teamId: string, input: TeamPlanInput, author: BotRow | null): Promise<TeamPlan> {
    await this.team(teamId);
    if (!(await this.keeps(teamId, author))) throw notKeeper();
    if (input.steps.length > PLAN_MAX_STEPS) throw tooManySteps();
    await this.checkRefs({
      bots: input.steps.map((step) => step.ownerBotId),
      tasks: input.steps.map((step) => step.taskId),
      project: input.projectId,
    });
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(teamPlans)
        .where(eq(teamPlans.teamId, teamId))
        .for('update');
      const before = existing
        ? await tx
            .select()
            .from(planSteps)
            .where(eq(planSteps.teamId, teamId))
            .orderBy(asc(planSteps.position))
        : [];
      const unmatched = [...before];
      const steps: StepValues[] = [];
      for (const step of input.steps) {
        const index = unmatched.findIndex((old) => sameTitle(old.title, step.title));
        const old = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
        steps.push({
          ...(old ? { id: old.id } : {}),
          title: step.title,
          status: step.status ?? old?.status ?? 'todo',
          ownerBotId: step.ownerBotId !== undefined ? step.ownerBotId : (old?.ownerBotId ?? null),
          taskId: step.taskId !== undefined ? step.taskId : (old?.taskId ?? null),
        });
      }
      const values = { goal: input.goal, authorBotId: author?.id ?? null, updatedAt: now };
      const project = input.projectId !== undefined ? { projectId: input.projectId } : {};
      if (existing) {
        await tx
          .update(teamPlans)
          .set({ ...values, ...project })
          .where(eq(teamPlans.teamId, teamId));
      } else {
        await tx.insert(teamPlans).values({ teamId, ...values, ...project, createdAt: now });
      }
      await this.writeSteps(tx, teamId, await this.withTasks(tx, steps));
    });
    return this.publish(teamId);
  }

  /** Changes some steps, adds or removes some. `actor` null: the user. */
  async update(teamId: string, edit: PlanEdit, actor: BotRow | null): Promise<TeamPlan> {
    const keeper = await this.keeps(teamId, actor);
    const edits = edit.steps ?? [];
    const onlyStatus =
      edit.goal === undefined &&
      edit.projectId === undefined &&
      !edit.add?.length &&
      edits.every(
        (e) =>
          e.title === undefined &&
          e.ownerBotId === undefined &&
          e.taskId === undefined &&
          !e.remove,
      );
    if (!keeper && !onlyStatus) throw notKeeper();
    await this.checkRefs({
      bots: [...edits.map((e) => e.ownerBotId), ...(edit.add ?? []).map((a) => a.ownerBotId)],
      tasks: edits.map((e) => e.taskId),
      project: edit.projectId,
    });
    await this.db.transaction(async (tx) => {
      const [plan] = await tx
        .select()
        .from(teamPlans)
        .where(eq(teamPlans.teamId, teamId))
        .for('update');
      if (!plan) {
        throw new HttpProblem(
          404,
          'no_plan',
          "L'équipe n'a pas encore de plan : il s'écrit avec plan_set.",
        );
      }
      const before = await tx
        .select()
        .from(planSteps)
        .where(eq(planSteps.teamId, teamId))
        .orderBy(asc(planSteps.position));
      const count = before.length;
      const at = (n: number) => {
        const step = before[n - 1];
        if (!Number.isInteger(n) || !step) {
          throw new HttpProblem(
            400,
            'no_such_step',
            count
              ? `Il n'y a pas d'étape ${n} : le plan en compte ${count}.`
              : "Le plan n'a pas encore d'étape.",
          );
        }
        return step;
      };
      const changed = new Map<number, StepValues>();
      const removed = new Set<number>();
      for (const e of edits) {
        const old = at(e.step);
        if (!keeper && old.ownerBotId !== actor?.id) {
          throw new HttpProblem(
            403,
            'not_your_step',
            `L'étape ${e.step} n'est pas à toi : demande au lead de l'équipe de la changer.`,
          );
        }
        if (e.remove) {
          removed.add(e.step);
          continue;
        }
        const current = changed.get(e.step) ?? { ...old };
        const taskId = e.taskId !== undefined ? e.taskId : current.taskId;
        if (actor && e.status !== undefined && taskId && e.taskId === undefined) {
          throw new HttpProblem(
            409,
            'step_follows_task',
            `L'étape ${e.step} suit sa tâche (id ${taskId}) : c'est la tâche qui avance (update_task), ou détache-la (task vide).`,
          );
        }
        changed.set(e.step, {
          ...current,
          ...(e.title !== undefined ? { title: e.title } : {}),
          ...(e.status !== undefined ? { status: e.status } : {}),
          ...(e.ownerBotId !== undefined ? { ownerBotId: e.ownerBotId } : {}),
          ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
        });
      }
      const additions = new Map<number, StepValues[]>();
      for (const add of edit.add ?? []) {
        const after = add.after ?? count;
        if (after !== 0) at(after);
        additions.set(after, [
          ...(additions.get(after) ?? []),
          { title: add.title, status: add.status ?? 'todo', ownerBotId: add.ownerBotId ?? null },
        ]);
      }
      const steps: StepValues[] = [...(additions.get(0) ?? [])];
      before.forEach((old, index) => {
        const n = index + 1;
        if (!removed.has(n)) steps.push(changed.get(n) ?? old);
        steps.push(...(additions.get(n) ?? []));
      });
      if (steps.length > PLAN_MAX_STEPS) throw tooManySteps();
      await tx
        .update(teamPlans)
        .set({
          ...(edit.goal !== undefined ? { goal: edit.goal } : {}),
          ...(edit.projectId !== undefined ? { projectId: edit.projectId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(teamPlans.teamId, teamId));
      await this.writeSteps(tx, teamId, await this.withTasks(tx, steps));
    });
    return this.publish(teamId);
  }

  /** Clears the team's plan (a new project, the team starting over). */
  async clear(teamId: string): Promise<boolean> {
    const gone = await this.db
      .delete(teamPlans)
      .where(eq(teamPlans.teamId, teamId))
      .returning({ teamId: teamPlans.teamId });
    if (gone.length === 0) return false;
    this.events.publish({ type: 'plan.updated', teamId, plan: null });
    return true;
  }

  /** The step numbered `n` of the team's plan, or why there is none. */
  async step(teamId: string, n: number): Promise<StepRow> {
    const steps = await this.steps(teamId);
    const step = steps[n - 1];
    if (step) return step;
    throw new HttpProblem(
      400,
      'no_such_step',
      steps.length
        ? `Il n'y a pas d'étape ${n} : le plan de l'équipe en compte ${steps.length}.`
        : "L'équipe n'a pas de plan, ou pas encore d'étape.",
    );
  }

  /** A task now carries step `n`: the step goes to the task's assignee and follows it. */
  async attach(teamId: string, n: number, task: TaskRow): Promise<void> {
    const step = await this.step(teamId, n);
    await this.db.transaction(async (tx) => {
      await tx.select().from(teamPlans).where(eq(teamPlans.teamId, teamId)).for('update');
      await tx
        .update(planSteps)
        .set({ taskId: task.id, ownerBotId: task.assigneeBotId, status: FROM_TASK[task.status] })
        .where(eq(planSteps.id, step.id));
      await tx.update(teamPlans).set({ updatedAt: new Date() }).where(eq(teamPlans.teamId, teamId));
    });
    await this.publish(teamId);
  }

  /** A task moved: the steps it carries follow it (a cancelled one lets go of its step). */
  async followTask(task: TaskRow): Promise<void> {
    const linked = await this.db.select().from(planSteps).where(eq(planSteps.taskId, task.id));
    const teamIds = [...new Set(linked.map((step) => step.teamId))];
    for (const teamId of teamIds) {
      await this.db.transaction(async (tx) => {
        await tx.select().from(teamPlans).where(eq(teamPlans.teamId, teamId)).for('update');
        await tx
          .update(planSteps)
          .set({
            status: FROM_TASK[task.status],
            ...(task.status === 'cancelled' ? { taskId: null } : {}),
          })
          .where(eq(planSteps.taskId, task.id));
        await tx
          .update(teamPlans)
          .set({ updatedAt: new Date() })
          .where(eq(teamPlans.teamId, teamId));
      });
      await this.publish(teamId);
    }
  }

  /**
   * The plan as bots read it: the goal (and its project), then each step with its number,
   * status and owner. `selfId` is marked « toi ».
   */
  async text(plan: TeamPlan, selfId?: string): Promise<string> {
    const names = new Map(
      (await this.db.select({ id: bots.id, name: bots.name }).from(bots)).map((b) => [
        b.id,
        b.name,
      ]),
    );
    const [project] = plan.projectId
      ? await this.db
          .select({ name: projects.name })
          .from(projects)
          .where(eq(projects.id, plan.projectId))
      : [];
    const done = plan.steps.filter((step) => step.status === 'done').length;
    const lines = [
      `Objectif : ${plan.goal}${project ? ` (projet ${project.name})` : ''}`,
      ...plan.steps.map((step, index) => {
        const owner = step.ownerBotId ? names.get(step.ownerBotId) : undefined;
        return [
          `${index + 1}. [${PLAN_STATUS_LABELS[step.status]}] ${clip(step.title, 160)}`,
          owner ? ` — ${owner}${step.ownerBotId === selfId ? ' (toi)' : ''}` : '',
          step.taskId ? ' · suit sa tâche' : '',
        ].join('');
      }),
      plan.steps.length ? `Avancement : ${done}/${plan.steps.length}.` : 'Pas encore d’étape.',
    ];
    return lines.join('\n');
  }

  /** The plan in one line: its goal and how far it got (the Chef's overview of other teams). */
  summary(plan: TeamPlan): string {
    const done = plan.steps.filter((step) => step.status === 'done').length;
    const blocked = plan.steps.filter((step) => step.status === 'blocked').length;
    return [
      clip(plan.goal, 120),
      ` — ${done}/${plan.steps.length}`,
      blocked ? `, ${blocked} bloquée${blocked > 1 ? 's' : ''}` : '',
    ].join('');
  }

  private async steps(teamId: string): Promise<StepRow[]> {
    return this.db
      .select()
      .from(planSteps)
      .where(eq(planSteps.teamId, teamId))
      .orderBy(asc(planSteps.position));
  }

  private async team(teamId: string): Promise<void> {
    const [team] = await this.db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
    if (!team) throw notFound('Team not found');
  }

  /** Bots, tasks and the project a plan names must exist. */
  private async checkRefs(refs: {
    bots: (string | null | undefined)[];
    tasks: (string | null | undefined)[];
    project: string | null | undefined;
  }): Promise<void> {
    const botIds = [...new Set(refs.bots.filter((id): id is string => Boolean(id)))];
    const taskIds = [...new Set(refs.tasks.filter((id): id is string => Boolean(id)))];
    if (botIds.length) {
      const found = await this.db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.id, botIds));
      if (found.length < botIds.length) throw new HttpProblem(400, 'unknown_bot', 'Unknown bot');
    }
    if (taskIds.length) {
      const found = await this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, taskIds));
      if (found.length < taskIds.length) {
        throw new HttpProblem(400, 'unknown_task', 'Aucune tâche avec cet id.');
      }
    }
    if (refs.project) {
      const [found] = await this.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, refs.project));
      if (!found) throw new HttpProblem(400, 'unknown_project', 'Unknown project');
    }
  }

  /** Steps that carry a task take its status; a cancelled task does not carry anything. */
  private async withTasks(tx: Db, steps: StepValues[]): Promise<StepValues[]> {
    const ids = steps.flatMap((step) => (step.taskId ? [step.taskId] : []));
    if (ids.length === 0) return steps;
    const statuses = new Map(
      (
        await tx
          .select({ id: tasks.id, status: tasks.status })
          .from(tasks)
          .where(inArray(tasks.id, ids))
      ).map((task) => [task.id, task.status]),
    );
    return steps.map((step) => {
      const status = step.taskId ? statuses.get(step.taskId) : undefined;
      if (!step.taskId) return step;
      if (!status || status === 'cancelled') return { ...step, taskId: null };
      return { ...step, status: FROM_TASK[status] };
    });
  }

  private async writeSteps(tx: Db, teamId: string, steps: StepValues[]): Promise<void> {
    await tx.delete(planSteps).where(eq(planSteps.teamId, teamId));
    if (steps.length === 0) return;
    await tx
      .insert(planSteps)
      .values(steps.map((step, position) => ({ ...step, teamId, position })));
  }

  private async publish(teamId: string): Promise<TeamPlan> {
    const plan = await this.get(teamId);
    if (!plan) throw notFound('Plan not found');
    this.events.publish({ type: 'plan.updated', teamId, plan });
    return plan;
  }
}
