import {
  notificationPrioritySchema,
  questionLinkSchema,
  type RoutineTrigger,
} from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { and, count, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { BotRow, BotService } from '../bots/service';
import type { Db } from '../db/client';
import { bots, messages, notifications, routineRuns, routines, tasks, teams } from '../db/schema';
import { HttpProblem } from '../http/problems';
import { TASK_STATUS_LABELS } from '../org/tasks';
import type { NotificationService } from '../proactivity/notifications';
import type { QuestionService } from '../proactivity/questions';
import type { RoutineService } from '../proactivity/routines';
import { startOfDay } from '../proactivity/schedule';

export interface ProactiveToolContext {
  self: BotRow;
  routines: RoutineService;
  notifications: NotificationService;
  questions: QuestionService;
  ownerName: string;
  bots: BotService;
  db: Db;
}

const triggerSchema = z
  .object({
    cron: z
      .string()
      .optional()
      .describe('Expression cron à 5 champs, heure locale (ex. « 0 8 * * 1-5 » : 8 h en semaine)'),
    every_minutes: z.number().int().min(5).optional().describe('Intervalle en minutes (5 minimum)'),
    at: z.string().optional().describe('Une seule fois, date ISO 8601 avec fuseau'),
    webhook: z
      .boolean()
      .optional()
      .describe("Déclenchée par un appel HTTP (l'utilisateur récupère l'URL dans l'app)"),
  })
  .describe('Exactement un des quatre');

function toTrigger(input: z.infer<typeof triggerSchema>): RoutineTrigger {
  const given = [input.cron, input.every_minutes, input.at, input.webhook].filter(
    (value) => value !== undefined && value !== false,
  );
  if (given.length !== 1)
    throw new Error('Donne exactement un déclencheur : cron, every_minutes, at ou webhook.');
  if (input.cron) return { type: 'cron', expr: input.cron };
  if (input.every_minutes) return { type: 'interval', minutes: input.every_minutes };
  if (input.at) return { type: 'once', at: input.at };
  return { type: 'webhook' };
}

const describeTrigger = (trigger: RoutineTrigger) => {
  switch (trigger.type) {
    case 'cron':
      return `cron « ${trigger.expr} »`;
    case 'interval':
      return `toutes les ${trigger.minutes} min`;
    case 'once':
      return `une fois, le ${trigger.at}`;
    case 'webhook':
      return 'par webhook';
  }
};

/** API errors carry details meant for clients; bots get the message. */
const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/** Routines, check-ins, notifications to the user; the activity report for the Chef. */
export function buildProactiveTools(ctx: ProactiveToolContext): ToolSet {
  const { self, db } = ctx;
  const routineService = ctx.routines;
  const notifier = ctx.notifications;
  const tools: ToolSet = {};

  /** A bot manages its own routines; the Chef can manage everyone's. */
  const ownRoutine = async (id: string) => {
    const routine = await routineService.row(id).catch(toolError);
    if (routine.botId !== self.id && !self.isChef) {
      throw new Error("Cette routine n'est pas à toi.");
    }
    return routine;
  };

  tools.create_routine = tool({
    description:
      "Crée une routine : un travail que tu feras toi-même, régulièrement ou plus tard, que l'utilisateur voit dans ses routines (veille quotidienne, rapport hebdo…). Quand elle se déclenche, tu reçois son instruction. Préfère un déclencheur rare et utile ; silencieuse par défaut (il n'est pas prévenu à chaque passage). Pour une attention ponctuelle que tu prends de toi-même (un rappel la veille d'un événement), c'est plan_initiative.",
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      instruction: z
        .string()
        .min(1)
        .max(4000)
        .describe('Ce que tu devras faire à chaque déclenchement, assez précis pour être autonome'),
      trigger: triggerSchema,
      notify_user: z
        .boolean()
        .default(false)
        .describe("Prévenir l'utilisateur du résultat à chaque passage"),
    }),
    execute: async ({ name, instruction, trigger, notify_user }) => {
      const routine = await routineService
        .create(
          {
            botId: self.id,
            name,
            prompt: instruction,
            trigger: toTrigger(trigger),
            silent: !notify_user,
          },
          'bot',
        )
        .catch(toolError);
      return `Routine « ${routine.name} » créée (id ${routine.id}, ${describeTrigger(routine.trigger)}${routine.nextRunAt ? `, prochain passage ${routine.nextRunAt}` : ''}).`;
    },
  });

  tools.list_routines = tool({
    description: 'Tes routines (le Chef : celles de tous les bots), avec leur état.',
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await db
        .select({ routine: routines, bot: bots.name })
        .from(routines)
        .innerJoin(bots, eq(bots.id, routines.botId))
        .where(self.isChef ? undefined : eq(routines.botId, self.id))
        .orderBy(routines.createdAt);
      const initiatives = (await routineService.initiatives(self.isChef ? undefined : self.id)).map(
        (r) =>
          `- [${r.id.slice(0, 8)}] initiative pour ${r.nextRunAt?.toISOString()} : ${r.prompt}`,
      );
      const shown = rows.filter(({ routine: r }) => r.kind !== 'initiative');
      if (shown.length === 0 && initiatives.length === 0) return 'Aucune routine.';
      return [
        ...shown.map(
          ({ routine: r, bot }) =>
            `- [${r.id}] ${r.name}${self.isChef ? ` (${bot})` : ''} — ${describeTrigger(r.trigger)}, ${r.enabled ? 'active' : 'désactivée'}${r.lastStatus ? `, dernier passage : ${r.lastStatus}` : ''}`,
        ),
        ...(initiatives.length ? ['Initiatives prévues :', ...initiatives] : []),
      ].join('\n');
    },
  });

  tools.update_routine = tool({
    description: 'Modifie, désactive ou réactive une de tes routines.',
    inputSchema: z.object({
      id: z.uuid(),
      name: z.string().min(1).max(100).optional(),
      instruction: z.string().min(1).max(4000).optional(),
      trigger: triggerSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    execute: async ({ id, name, instruction, trigger, enabled }) => {
      await ownRoutine(id);
      const routine = await routineService
        .update(id, {
          ...(name ? { name } : {}),
          ...(instruction ? { prompt: instruction } : {}),
          ...(trigger ? { trigger: toTrigger(trigger) } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
        })
        .catch(toolError);
      return `Routine « ${routine.name} » mise à jour (${routine.enabled ? 'active' : 'désactivée'}).`;
    },
  });

  tools.delete_routine = tool({
    description: 'Supprime une de tes routines devenue inutile.',
    inputSchema: z.object({ id: z.uuid() }),
    execute: async ({ id }) => {
      const routine = await ownRoutine(id);
      if (routine.kind !== 'custom') {
        throw new Error(
          routine.kind === 'heartbeat'
            ? 'Pour arrêter tes réveils, utilise set_heartbeat avec minutes: null.'
            : "Cette routine appartient à l'instance : l'utilisateur peut la désactiver dans l'app.",
        );
      }
      await routineService.remove(id);
      return `Routine « ${routine.name} » supprimée.`;
    },
  });

  tools.set_heartbeat = tool({
    description:
      "Règle tes réveils périodiques : toutes les N minutes, tu fais le point sur ta mission et agis si c'est utile. null pour les arrêter. Utile quand ta mission demande de la vigilance continue ; sinon préfère des routines ciblées.",
    inputSchema: z.object({
      minutes: z
        .number()
        .int()
        .min(15)
        .max(60 * 24)
        .nullable(),
    }),
    execute: async ({ minutes }) => {
      await ctx.bots.update(self.id, { heartbeatMinutes: minutes });
      await routineService.syncHeartbeat({ ...self, heartbeatMinutes: minutes });
      return minutes ? `Réveil toutes les ${minutes} minutes.` : 'Réveils arrêtés.';
    },
  });

  tools.plan_initiative = tool({
    description:
      "Prévois toi-même de faire quelque chose pour l'utilisateur à un moment précis, sans qu'il te l'ait demandé : la veille d'une compétition (« pense à te reposer », l'itinéraire), le matin d'un vol (ressortir le billet, le check-in), avant une échéance (vérifier qu'un formulaire est parti). Il ne la voit nulle part (c'est ton initiative) : ne la lui annonce pas. Le moment venu, tu reçois what et tu agis (notify_user, ask_user, le travail lui-même).",
    inputSchema: z.object({
      at: z.string().describe('Quand : date et heure ISO 8601 avec fuseau, dans le futur'),
      what: z
        .string()
        .trim()
        .min(1)
        .max(1_000)
        .describe(
          "Ce que tu feras alors, assez précis pour être autonome (avec ce qu'il te faudra)",
        ),
    }),
    execute: async ({ at, what }) => {
      const when = new Date(at);
      if (Number.isNaN(when.getTime())) throw new Error(`« ${at} » n'est pas une date ISO.`);
      const row = await routineService
        .planInitiative(self, when.toISOString(), what)
        .catch(toolError);
      return `Initiative prévue [${row.id.slice(0, 8)}] pour ${row.nextRunAt?.toISOString() ?? at}.`;
    },
  });

  tools.cancel_initiative = tool({
    description:
      "Annule une de tes initiatives devenue inutile (l'événement est annulé, c'est déjà fait).",
    inputSchema: z.object({
      id: z.string().trim().min(4).describe('Son id (les 8 premiers caractères suffisent)'),
    }),
    execute: async ({ id }) => {
      const mine = await routineService.initiatives(self.id);
      const found = mine.find((row) => row.id.startsWith(id.trim().replace(/^\[|\]$/g, '')));
      if (!found) throw new Error(`Aucune de tes initiatives n'a l'id « ${id} » (list_routines).`);
      await routineService.remove(found.id);
      return 'Initiative annulée.';
    },
  });

  tools.notify_user = tool({
    description:
      "Prévient l'utilisateur, même s'il n'est pas dans l'app : « urgent » pour ce qui ne peut pas attendre, « normal » pour un résultat ou une info utile, « digest » pour ce qui peut attendre le bilan du soir. Avec parcimonie.",
    inputSchema: z.object({
      title: z.string().min(1).max(120),
      body: z.string().max(2000).optional(),
      priority: notificationPrioritySchema.default('normal'),
    }),
    execute: async ({ title, body, priority }) => {
      await notifier.create({ botId: self.id, priority, title, body });
      return priority === 'digest' ? 'Gardé pour le bilan du soir.' : "L'utilisateur est prévenu.";
    },
  });

  tools.ask_user = tool({
    description:
      "Pose une question à l'utilisateur, avec des réponses toutes prêtes qu'il choisit d'un clic (il peut aussi écrire la sienne). Il est prévenu, et la question s'ouvre comme une fenêtre dans l'app : joins-y ce qui l'aide à décider (details : ce que tu as trouvé ou préparé ; image : la photo du produit, une capture ; link : la page). Sa réponse t'arrive plus tard comme un message : ne l'attends pas, termine ton tour.",
    inputSchema: z.object({
      question: z.string().trim().min(1).max(500),
      options: z
        .array(z.string().trim().min(1).max(60))
        .max(6)
        .default([])
        .describe('2 à 4 réponses courtes quand c’est possible (ex. « Oui », « Non, plus tard »)'),
      details: z
        .string()
        .trim()
        .max(1_000)
        .optional()
        .describe(
          'Quelques lignes en Markdown : ce que tu as trouvé ou préparé (prix, date, résumé)',
        ),
      image: z
        .string()
        .trim()
        .max(2_000)
        .optional()
        .describe('Une image : un fichier de /workspace (outputs/produit.png) ou une adresse web'),
      link: questionLinkSchema
        .optional()
        .describe('La page à voir avant de répondre (le produit, le formulaire)'),
    }),
    execute: async ({ question, options, details, image, link }) => {
      await ctx.questions
        .ask(self, question, [...new Set(options)], {
          ...(details ? { details } : {}),
          ...(image ? { image: image.replace(/^\/?workspace\//, '') } : {}),
          ...(link ? { link } : {}),
        })
        .catch(toolError);
      return `Question posée à ${ctx.ownerName}. Sa réponse t'arrivera comme un message : termine ton tour maintenant (en une phrase, sans répéter la question), ou avance sur ce qui n'en dépend pas.`;
    },
  });

  if (self.isChef) {
    tools.activity_report = tool({
      description:
        "Ce que l'organisation a fait aujourd'hui : messages par bot, tâches, routines, notifications en attente du bilan. Pour le bilan du soir.",
      inputSchema: z.object({}),
      execute: async () => {
        const since = startOfDay(new Date(), routineService.timeZone);
        const [allBots, allTeams] = await Promise.all([
          db.select().from(bots).orderBy(bots.createdAt),
          db.select({ id: teams.id, name: teams.name }).from(teams),
        ]);
        const teamName = new Map(allTeams.map((t) => [t.id, t.name]));
        const name = new Map(allBots.map((b) => [b.id, b.name]));
        const answers = await db
          .select({ botId: messages.botId, total: count() })
          .from(messages)
          .where(and(eq(messages.role, 'assistant'), gte(messages.createdAt, since)))
          .groupBy(messages.botId);
        const exchanges = await db
          .select({ total: count() })
          .from(messages)
          .where(and(isNotNull(messages.fromBotId), gte(messages.createdAt, since)));
        const touched = await db
          .select()
          .from(tasks)
          .where(gte(tasks.updatedAt, since))
          .orderBy(desc(tasks.updatedAt));
        const runs = await db
          .select({ name: routines.name, botId: routines.botId, status: routineRuns.status })
          .from(routineRuns)
          .innerJoin(routines, eq(routines.id, routineRuns.routineId))
          .where(gte(routineRuns.startedAt, since));
        const pending = await db
          .select()
          .from(notifications)
          .where(
            and(
              eq(notifications.priority, 'digest'),
              isNull(notifications.readAt),
              gte(notifications.createdAt, since),
            ),
          );
        const lines = [
          `Réponses par bot : ${
            answers
              .map(
                (a) =>
                  `${name.get(a.botId) ?? '?'} ${a.total}${(() => {
                    const team = allBots.find((b) => b.id === a.botId)?.teamId;
                    return team ? ` (${teamName.get(team)})` : '';
                  })()}`,
              )
              .join(', ') || 'aucune'
          }.`,
          `Messages entre bots : ${exchanges[0]?.total ?? 0}.`,
          'Tâches qui ont bougé :',
          ...(touched.length
            ? touched.map(
                (t) =>
                  `- ${t.title} (${name.get(t.assigneeBotId) ?? '?'}, ${TASK_STATUS_LABELS[t.status]})${t.result ? ` : ${t.result.slice(0, 200)}` : ''}`,
              )
            : ['- aucune']),
          `Passages de routines : ${
            runs.length
              ? Object.entries(
                  runs.reduce<Record<string, number>>((acc, r) => {
                    const key = `${r.name} (${name.get(r.botId) ?? '?'}) ${r.status}`;
                    acc[key] = (acc[key] ?? 0) + 1;
                    return acc;
                  }, {}),
                )
                  .map(([key, n]) => `${key} ×${n}`)
                  .join(', ')
              : 'aucun'
          }.`,
          'Infos gardées pour le bilan :',
          ...(pending.length
            ? pending.map(
                (n) =>
                  `- ${name.get(n.botId ?? '') ?? 'MowBot'} : ${n.title}${n.body ? ` — ${n.body}` : ''}`,
              )
            : ['- aucune']),
        ];
        // They are in the summary now.
        await notifier.markRead(pending.map((n) => n.id));
        return lines.join('\n');
      },
    });
  }

  return tools;
}
