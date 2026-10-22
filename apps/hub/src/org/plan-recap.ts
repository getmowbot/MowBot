import type { TeamPlan } from '@mowbot/contract';
import { eq, inArray } from 'drizzle-orm';
import type { BotService } from '../bots/service';
import type { Logger } from '../computers/service';
import type { Db } from '../db/client';
import { tasks, teams } from '../db/schema';
import type { EventBus } from '../events';
import type { RoutineService } from '../proactivity/routines';
import type { PlanService } from './plans';

/** Long enough after the last step for its bot to have said its piece. */
const RECAP_DELAY_MS = 10_000;

const isDone = (plan: TeamPlan) =>
  plan.steps.length > 0 && plan.steps.every((step) => step.status === 'done');

/**
 * A team's plan done, the mission ends for the user too: whoever answers to them for it (the
 * Chef when it handed the steps out, else the team's lead) gets an initiative, unseen, to give
 * them the whole recap where they talk (and a document for a study), unless it already did.
 * The user then never has to read the bots' exchanges to know how it ended.
 */
export class PlanEnds {
  private log: Logger = { warn: () => {}, error: () => {} };
  private stop: (() => void) | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      events: EventBus;
      plans: PlanService;
      routines: RoutineService;
      bots: BotService;
    },
  ) {}

  setLogger(log: Logger): void {
    this.log = log;
  }

  async watch(): Promise<void> {
    const { events, plans } = this.deps;
    // Plans already done when the hub starts were wrapped up before.
    const done = new Set((await plans.all()).filter(isDone).map((plan) => plan.teamId));
    this.stop?.();
    this.stop = events.subscribe((event) => {
      if (event.type !== 'plan.updated') return;
      const { teamId, plan } = event;
      if (!plan || !isDone(plan)) {
        done.delete(teamId);
        return;
      }
      if (done.has(teamId)) return;
      done.add(teamId);
      void this.recap(plan).catch((error: unknown) =>
        this.log.warn({ err: error, teamId }, 'Could not plan the recap of a finished plan'),
      );
    });
  }

  close(): void {
    this.stop?.();
    this.stop = null;
  }

  private async recap(plan: TeamPlan): Promise<void> {
    const { db, plans, routines, bots } = this.deps;
    const [team] = await db.select().from(teams).where(eq(teams.id, plan.teamId));
    if (!team) return;
    const chef = await bots.chef();
    const taskIds = plan.steps.flatMap((step) => (step.taskId ? [step.taskId] : []));
    const creators = taskIds.length
      ? (
          await db
            .select({ creator: tasks.creatorBotId })
            .from(tasks)
            .where(inArray(tasks.id, taskIds))
        ).map((row) => row.creator)
      : [];
    const reporterId =
      chef && creators.includes(chef.id) ? chef.id : (team.leadBotId ?? chef?.id ?? null);
    if (!reporterId) return;
    const reporter = await bots.row(reporterId);
    const what = [
      `Le plan de l'équipe ${team.name} est terminé.`,
      await plans.text(plan, reporter.id),
      "Si l'utilisateur n'a pas encore eu le récap complet de cette mission, fais-le maintenant dans ta conversation avec lui : la conclusion d'abord, puis l'essentiel de ce que l'équipe a trouvé ou produit (chiffres, choix, liens), pas qui a fait quoi ; il ne doit pas avoir à lire vos échanges. Une étude, une veille, un comparatif : rassemble-le aussi dans un document (/workspace/outputs, en Markdown) et montre-le (show_in_chat, kind file). Préviens-le avec notify_user, en un titre court. S'il a déjà eu ce récap, réponds seulement « RAS ».",
    ].join('\n\n');
    await routines.planInitiative(
      reporter,
      new Date(Date.now() + RECAP_DELAY_MS).toISOString(),
      what,
    );
  }
}
