import { PLAN_MAX_STEPS, planStepStatusSchema, type Team } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BotRow, BotService } from '../bots/service';
import type { ConnectorService } from '../connectors/service';
import type { Db } from '../db/client';
import { bots } from '../db/schema';
import { HttpProblem } from '../http/problems';
import type { PlanService, StepEdit } from '../org/plans';
import { eqName, type OrgService } from '../org/service';

/** What the plan tools of a bot act on. */
export interface PlanToolContext {
  self: BotRow;
  plans: PlanService;
  org: OrgService;
  bots: BotService;
  db: Db;
  /** The user's projects, which a plan can be about. */
  connectors?: ConnectorService;
}

/** API errors (HttpProblem) carry English details for clients; bots get the message. */
const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE = /^(aucun|aucune|personne|none|nobody)?$/i;

const TEAM = z.string().optional().describe("Nom de l'équipe ; par défaut la tienne");
const OWNER = z.string().optional().describe('Nom du bot responsable');
const GOAL = z
  .string()
  .min(1)
  .max(500)
  .describe(
    "Ce que l'équipe veut obtenir, en une ou deux phrases, dans la langue de l'utilisateur",
  );
const TITLE = z
  .string()
  .min(1)
  .max(200)
  .describe("Courte et concrète (« Maquettes de la page d'accueil »)");

/**
 * The team's plan of attack: plan_show for any bot; plan_set for the bots that keep plans (a
 * team's lead, the Chef); plan_update for them and the members, who mark their own steps.
 */
export async function buildPlanTools(ctx: PlanToolContext): Promise<ToolSet> {
  const { self, plans, org, db } = ctx;
  const tools: ToolSet = {};
  const teams = await org.listTeams();
  const keeper = self.isChef || teams.some((team) => team.leadBotId === self.id);

  const findTeam = async (ref: string | undefined): Promise<Team> => {
    const value = ref?.trim();
    const all = await org.listTeams();
    if (!value) {
      const own = all.find((team) => team.id === self.teamId);
      if (!own) throw new Error("Tu n'es dans aucune équipe : précise team.");
      return own;
    }
    const found = all.find(
      (team) => team.id === value || team.name.toLowerCase() === value.toLowerCase(),
    );
    if (!found) throw new Error(`Aucune équipe « ${value} ». Regarde list_bots.`);
    return found;
  };

  /** A bot by name or id; empty, « personne »: nobody. */
  const ownerId = async (ref: string | undefined): Promise<string | null | undefined> => {
    if (ref === undefined) return undefined;
    const value = ref.trim();
    if (NONE.test(value)) return null;
    const [found] = await db
      .select({ id: bots.id })
      .from(bots)
      .where(UUID.test(value) ? eq(bots.id, value) : eqName(value));
    if (!found) throw new Error(`Aucun bot ne s'appelle « ${value} ». Regarde list_bots.`);
    return found.id;
  };

  /** One of the user's projects this bot reaches, by name; « aucun »: none. */
  const projectId = async (ref: string | undefined): Promise<string | null | undefined> => {
    if (ref === undefined) return undefined;
    const value = ref.trim();
    if (NONE.test(value)) return null;
    const mine = ctx.connectors ? await ctx.connectors.accessibleTo(self) : [];
    const found = mine.find((p) => p.name.toLowerCase() === value.toLowerCase());
    if (!found) throw new Error(`Aucun projet « ${value} ». Regarde local_projects.`);
    return found.id;
  };

  tools.plan_show = tool({
    description:
      "Le plan d'attaque d'une équipe : son objectif, ses étapes dans l'ordre, qui s'en occupe et où elles en sont.",
    inputSchema: z.object({ team: TEAM }),
    execute: async ({ team }) => {
      const found = await findTeam(team);
      if (found.isolated && found.id !== self.teamId && !self.isChef) {
        throw new Error(
          `L'équipe ${found.name} est cloisonnée : son plan ne se lit que de l'intérieur.`,
        );
      }
      const plan = await plans.get(found.id);
      return plan
        ? `Plan de l'équipe ${found.name} :\n${await plans.text(plan, self.id)}`
        : `L'équipe ${found.name} n'a pas de plan.`;
    },
  });

  if (keeper) {
    tools.plan_set = tool({
      description: `Écrit le plan d'attaque d'une équipe (la tienne ; le Chef : n'importe laquelle) : l'objectif, puis les étapes dans l'ordre (${PLAN_MAX_STEPS} au plus), chacune avec son responsable. Fais-le quand tu lances un travail en plusieurs étapes, avant de déléguer, puis confie chaque étape avec assign_task (step). Il remplace le plan d'avant (nouveau projet, nouveau plan) ; une étape qui garde son titre garde son statut et sa tâche. L'utilisateur le voit sur la page de l'équipe.`,
      inputSchema: z.object({
        team: TEAM,
        goal: GOAL,
        project: z
          .string()
          .optional()
          .describe(
            "Projet de l'utilisateur concerné : par défaut ton projet actif ; « aucun » s'il n'y en a pas",
          ),
        steps: z
          .array(
            z.object({
              title: TITLE,
              owner: OWNER,
              status: planStepStatusSchema.optional().describe('Par défaut : todo'),
            }),
          )
          .min(1)
          .max(PLAN_MAX_STEPS)
          .describe("Les étapes, dans l'ordre"),
      }),
      execute: async ({ team, goal, project, steps }) => {
        const found = await findTeam(team);
        if (!(await plans.keeps(found.id, self))) {
          throw new Error(`Seuls le lead de l'équipe ${found.name} et le Chef écrivent son plan.`);
        }
        const active = (await ctx.bots.row(self.id)).projectId;
        const where = project === undefined ? active : await projectId(project);
        const input = [];
        for (const step of steps) {
          input.push({
            title: step.title,
            ...(step.status ? { status: step.status } : {}),
            ...(step.owner !== undefined ? { ownerBotId: await ownerId(step.owner) } : {}),
          });
        }
        const plan = await plans
          .set(found.id, { goal, projectId: where ?? null, steps: input }, self)
          .catch(toolError);
        return `Plan de l'équipe ${found.name} écrit :\n${await plans.text(plan, self.id)}`;
      },
    });
  }

  if (keeper || self.teamId) {
    tools.plan_update = tool({
      description:
        "Met à jour le plan d'une équipe : le statut, le titre ou le responsable d'étapes (par leur numéro), des étapes en plus ou en moins, l'objectif. Le lead et le Chef changent tout ; un membre marque ses propres étapes (doing quand il s'y met, puis done, ou blocked). Une étape qui suit une tâche avance avec la tâche (update_task).",
      inputSchema: z.object({
        team: TEAM,
        goal: GOAL.optional(),
        project: z
          .string()
          .optional()
          .describe("Projet de l'utilisateur concerné ; « aucun » s'il n'y en a pas"),
        steps: z
          .array(
            z.object({
              step: z.number().int().min(1).describe('Son numéro dans le plan'),
              status: planStepStatusSchema.optional(),
              title: TITLE.optional(),
              owner: z.string().optional().describe('Nom du bot responsable ; vide : personne'),
              task: z
                .string()
                .optional()
                .describe("Id d'une tâche qui porte l'étape (elle la suit) ; vide : la détacher"),
              remove: z.boolean().optional().describe("Retirer l'étape du plan"),
            }),
          )
          .max(PLAN_MAX_STEPS)
          .optional()
          .describe("Les étapes à changer, par leur numéro d'avant cet appel"),
        add: z
          .array(
            z.object({
              title: TITLE,
              owner: OWNER,
              after: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe("Après l'étape n (0 : en premier) ; par défaut, à la fin"),
            }),
          )
          .max(PLAN_MAX_STEPS)
          .optional()
          .describe('Les étapes à ajouter'),
      }),
      execute: async ({ team, goal, project, steps, add }) => {
        const found = await findTeam(team);
        const edits: StepEdit[] = [];
        for (const step of steps ?? []) {
          const task = step.task?.trim();
          if (task && !UUID.test(task)) throw new Error(`« ${task} » n'est pas un id de tâche.`);
          edits.push({
            step: step.step,
            ...(step.status ? { status: step.status } : {}),
            ...(step.title ? { title: step.title } : {}),
            ...(step.owner !== undefined ? { ownerBotId: await ownerId(step.owner) } : {}),
            ...(task !== undefined ? { taskId: task || null } : {}),
            ...(step.remove ? { remove: true } : {}),
          });
        }
        const additions = [];
        for (const item of add ?? []) {
          additions.push({
            title: item.title,
            ...(item.after !== undefined ? { after: item.after } : {}),
            ...(item.owner !== undefined ? { ownerBotId: await ownerId(item.owner) } : {}),
          });
        }
        const where = await projectId(project);
        const plan = await plans
          .update(
            found.id,
            {
              ...(goal ? { goal } : {}),
              ...(where !== undefined ? { projectId: where } : {}),
              steps: edits,
              add: additions,
            },
            self,
          )
          .catch(toolError);
        return `Plan de l'équipe ${found.name} à jour :\n${await plans.text(plan, self.id)}`;
      },
    });
  }

  return tools;
}
