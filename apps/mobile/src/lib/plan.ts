import type { TeamPlan } from '@mowbot/contract';

/** How far a plan got: its steps done, out of all of them. */
export function planProgress(plan: Pick<TeamPlan, 'steps'>): { done: number; total: number } {
  return {
    done: plan.steps.filter((step) => step.status === 'done').length,
    total: plan.steps.length,
  };
}
