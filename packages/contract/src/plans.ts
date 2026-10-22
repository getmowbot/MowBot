import { z } from 'zod';

/** Where a step of a team's plan stands. A step that carries a task follows its status. */
export const planStepStatusSchema = z.enum(['todo', 'doing', 'done', 'blocked']);
export type PlanStepStatus = z.infer<typeof planStepStatusSchema>;

/** At most this many steps in a plan. */
export const PLAN_MAX_STEPS = 30;
/** Longest wording of what a step will deliver, of what it delivered, and of its link. */
export const PLAN_DELIVERABLE_MAX = 200;
export const PLAN_RESULT_MAX = 300;
export const PLAN_LINK_MAX = 500;

export const planStepSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: planStepStatusSchema,
  /** The bot in charge of the step (null: nobody yet). */
  ownerBotId: z.uuid().nullable(),
  /** The task that carries the step: the step's status follows it. */
  taskId: z.uuid().nullable(),
  /** What the step will deliver (« La maquette de la page d'accueil »). */
  deliverable: z.string().nullable(),
  /** What it delivered, in a sentence, once done (its task's result when it carries one). */
  result: z.string().nullable(),
  /**
   * Where that is: a file of the team's workspace (`outputs/maquette.png`) or a web address
   * (a preview, a document).
   */
  link: z.string().nullable(),
});
export type PlanStep = z.infer<typeof planStepSchema>;

/**
 * A team's plan of attack: what it is after (and in which of the user's projects), then its
 * steps in order. Its lead or the Chef keeps it; each member marks its own steps.
 */
export const teamPlanSchema = z.object({
  teamId: z.uuid(),
  goal: z.string(),
  /** The user's project it is about. */
  projectId: z.uuid().nullable(),
  /** Who wrote it: a bot (its lead, the Chef), or the user (null). */
  authorBotId: z.uuid().nullable(),
  steps: z.array(planStepSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TeamPlan = z.infer<typeof teamPlanSchema>;

/** A team's plan, or null when it has none. */
export const teamPlanResultSchema = z.object({ plan: teamPlanSchema.nullable() });

/** Writes a team's plan over (the steps are given in order). */
export const teamPlanInputSchema = z.object({
  goal: z.string().trim().min(1).max(500),
  projectId: z.uuid().nullable().optional(),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        status: planStepStatusSchema.optional(),
        ownerBotId: z.uuid().nullable().optional(),
        /** A task of a bot that carries the step. */
        taskId: z.uuid().nullable().optional(),
        deliverable: z.string().trim().max(PLAN_DELIVERABLE_MAX).nullable().optional(),
        result: z.string().trim().max(PLAN_RESULT_MAX).nullable().optional(),
        link: z.string().trim().max(PLAN_LINK_MAX).nullable().optional(),
      }),
    )
    .max(PLAN_MAX_STEPS),
});
export type TeamPlanInput = z.infer<typeof teamPlanInputSchema>;
