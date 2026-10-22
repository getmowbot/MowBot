import type { PlanStepStatus, TeamPlan } from '@mowbot/contract';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyServerEvent } from './event-cache';
import { planProgress } from './plan';
import { keys } from './query-keys';

const TEAM = '00000000-0000-4000-8000-000000000001';

function plan(statuses: PlanStepStatus[]): TeamPlan {
  return {
    teamId: TEAM,
    goal: 'Refaire le site',
    projectId: null,
    authorBotId: null,
    steps: statuses.map((status, i) => ({
      id: `00000000-0000-4000-8000-00000000010${i}`,
      title: `Étape ${i + 1}`,
      status,
      ownerBotId: null,
      taskId: null,
    })),
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

describe('team plans', () => {
  it('counts the steps done', () => {
    expect(planProgress(plan(['done', 'doing', 'blocked', 'done', 'todo']))).toEqual({
      done: 2,
      total: 5,
    });
    expect(planProgress(plan([]))).toEqual({ done: 0, total: 0 });
  });

  it('follows the plan live, and drops it with its team', () => {
    const client = new QueryClient();
    client.setQueryData(keys.plan(TEAM), null);
    const written = plan(['todo', 'todo']);
    applyServerEvent(client, { type: 'plan.updated', teamId: TEAM, plan: written });
    expect(client.getQueryData(keys.plan(TEAM))).toEqual(written);
    applyServerEvent(client, { type: 'plan.updated', teamId: TEAM, plan: null });
    expect(client.getQueryData(keys.plan(TEAM))).toBeNull();
    applyServerEvent(client, { type: 'plan.updated', teamId: TEAM, plan: written });
    applyServerEvent(client, { type: 'team.deleted', teamId: TEAM });
    expect(client.getQueryData(keys.plan(TEAM))).toBeUndefined();
  });

  it('refetches it on reconnect', () => {
    const client = new QueryClient();
    client.setQueryData(keys.plan(TEAM), plan(['done']));
    applyServerEvent(client, { type: 'ready' });
    expect(client.getQueryState(keys.plan(TEAM))?.isInvalidated).toBe(true);
  });
});
