import { taskStatusSchema } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { type BotRow, type BotService, botFolder } from '../bots/service';
import type { Db } from '../db/client';
import { bots, computers, tasks, teams } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem } from '../http/problems';
import { eqName, type OrgService } from '../org/service';
import { TASK_STATUS_LABELS, type TaskService } from '../org/tasks';
import { parentOf, type WorkspaceFiles } from '../workspaces/files';
import type { BotRuntime } from './runtime';
import { workspacePath } from './tools';

/** What the organisation and communication tools of a bot act on. */
export interface OrgToolContext {
  self: BotRow;
  /** Hop count carried by what this bot sends now (loop guard). */
  depth: number;
  runtime: BotRuntime;
  org: OrgService;
  tasks: TaskService;
  bots: BotService;
  files: WorkspaceFiles;
  events: EventBus;
  db: Db;
}

const STATUS_LABELS: Record<BotRow['status'], string> = {
  idle: 'disponible',
  working: 'travaille',
  waiting_user: "attend l'utilisateur",
  waiting_bot: 'attend un autre bot',
  error: 'en erreur',
  paused: 'en pause',
};

/** API errors (HttpProblem) carry English details for clients; bots get the message. */
const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/** Directory, messages, questions and tasks between bots; teams and bots for the Chef and leads. */
export async function buildOrgTools(ctx: OrgToolContext): Promise<ToolSet> {
  const { self, db, runtime, org } = ctx;
  const tools: ToolSet = {};

  const findBot = async (ref: string): Promise<BotRow> => {
    const value = ref.trim();
    const [found] = await db
      .select()
      .from(bots)
      .where(/^[0-9a-f-]{36}$/i.test(value) ? eq(bots.id, value) : eqName(value));
    if (!found) throw new Error(`Aucun bot ne s'appelle « ${ref} ». Regarde list_bots.`);
    return found;
  };

  const findTeam = async (ref: string) => {
    const value = ref.trim().toLowerCase();
    const found = (await org.listTeams()).find(
      (team) => team.id === ref.trim() || team.name.toLowerCase() === value,
    );
    if (!found) throw new Error(`Aucune équipe « ${ref} ». Regarde list_bots.`);
    return found;
  };

  const ledTeams = async () =>
    (await org.listTeams()).filter((team) => team.leadBotId === self.id).map((team) => team.id);

  tools.list_bots = tool({
    description:
      "L'annuaire : les équipes (mission, lead, cloisonnement) et tous les bots avec leur rôle, leur mission, leur état et leur ordinateur.",
    inputSchema: z.object({}),
    execute: async () => {
      const [allTeams, allBots, pcs] = await Promise.all([
        org.listTeams(),
        db.select().from(bots).orderBy(bots.createdAt),
        db.select({ id: computers.id, kind: computers.kind }).from(computers),
      ]);
      const pcKind = new Map(pcs.map((pc) => [pc.id, pc.kind]));
      const line = (bot: BotRow) =>
        [
          `- ${bot.name}${bot.id === self.id ? ' (toi)' : ''} — ${bot.role}`,
          `, ${STATUS_LABELS[bot.status]}`,
          bot.computerId && pcKind.get(bot.computerId) === 'dedicated' ? ', PC dédié' : '',
          bot.mission ? `\n  Mission : ${bot.mission}` : '',
        ].join('');
      const sections = allTeams.map((team) => {
        const members = allBots.filter((bot) => bot.teamId === team.id);
        const lead = members.find((bot) => bot.id === team.leadBotId);
        return [
          `## Équipe ${team.name}${team.isolated ? ' (cloisonnée)' : ''}${lead ? ` — lead : ${lead.name}` : ''}`,
          team.mission ? `Mission : ${team.mission}` : '',
          ...(members.length ? members.map(line) : ['- (aucun bot)']),
        ]
          .filter(Boolean)
          .join('\n');
      });
      const solo = allBots.filter((bot) => !bot.teamId);
      if (solo.length) sections.push(['## Bots solo', ...solo.map(line)].join('\n'));
      return sections.join('\n\n');
    },
  });

  tools.send_message = tool({
    description:
      "Écrit à un autre bot, sans attendre de réponse : il le lira et agira à son tour. Pour une réponse dont tu as besoin pour continuer, utilise ask_bot ; pour un travail à suivre, assign_task. N'écris pas pour rien (« merci », « bien reçu »).",
    inputSchema: z.object({
      to: z.string().describe('Nom du bot'),
      text: z.string().min(1).max(8000),
    }),
    execute: async ({ to, text }) => {
      const target = await findBot(to);
      await runtime.checkReach(self, target, ctx.depth);
      await runtime.deliver(target.id, {
        from: self,
        kind: 'chat',
        text,
        meta: { depth: ctx.depth },
      });
      return `Message envoyé à ${target.name}.`;
    },
  });

  tools.ask_bot = tool({
    description:
      'Pose une question à un autre bot et attend sa réponse (quelques minutes au plus). Pour ce dont tu as besoin tout de suite ; sinon send_message ou assign_task.',
    inputSchema: z.object({
      to: z.string().describe('Nom du bot'),
      question: z.string().min(1).max(8000),
    }),
    execute: async ({ to, question }, { abortSignal }) => {
      const target = await findBot(to);
      const answer = await runtime.ask(self, target, question, ctx.depth, abortSignal);
      return `Réponse de ${target.name} :\n${answer}`;
    },
  });

  tools.assign_task = tool({
    description:
      "Confie une tâche à un bot (ou à toi-même pour t'organiser). Il est réveillé, la fait, puis la marque terminée avec update_task : tu reçois alors son résultat.",
    inputSchema: z.object({
      to: z.string().describe('Nom du bot'),
      title: z.string().min(1).max(200),
      details: z.string().max(8000).optional().describe('Contexte, attentes, où livrer'),
    }),
    execute: async ({ to, title, details }) => {
      const target = await findBot(to);
      if (target.id !== self.id) await runtime.checkReach(self, target, ctx.depth);
      const task = await ctx.tasks.create({ assignee: target, title, details }, self, ctx.depth);
      return `Tâche créée (id ${task.id}) pour ${target.name}.`;
    },
  });

  tools.update_task = tool({
    description:
      "Met à jour une tâche : statut (doing quand tu t'y mets, done quand c'est fini, blocked si tu es bloqué, cancelled) et résultat. L'autre partie est prévenue.",
    inputSchema: z.object({
      id: z.uuid(),
      status: taskStatusSchema,
      result: z
        .string()
        .max(8000)
        .optional()
        .describe('Ce que tu as fait, où sont les livrables, ou ce qui te bloque'),
    }),
    execute: async ({ id, status, result }) => {
      const task = await ctx.tasks
        .update(id, { status, ...(result !== undefined ? { result } : {}) }, self, ctx.depth)
        .catch(toolError);
      return `Tâche « ${task.title} » : ${TASK_STATUS_LABELS[task.status]}.`;
    },
  });

  tools.list_tasks = tool({
    description: 'Tes tâches : celles qui te sont confiées et celles que tu as confiées.',
    inputSchema: z.object({ include_finished: z.boolean().default(false) }),
    execute: async ({ include_finished }) => {
      const rows = await db
        .select()
        .from(tasks)
        .where(or(eq(tasks.assigneeBotId, self.id), eq(tasks.creatorBotId, self.id)));
      const names = new Map(
        (await db.select({ id: bots.id, name: bots.name }).from(bots)).map((b) => [b.id, b.name]),
      );
      const open = rows.filter(
        (task) => include_finished || !['done', 'cancelled'].includes(task.status),
      );
      if (open.length === 0) return 'Aucune tâche en cours.';
      return open
        .map((task) => {
          const mine = task.assigneeBotId === self.id;
          const other = mine
            ? task.creatorBotId
              ? `de ${names.get(task.creatorBotId)}`
              : "de l'utilisateur"
            : `pour ${names.get(task.assigneeBotId)}`;
          return `- [${task.id}] ${task.title} (${other}, ${TASK_STATUS_LABELS[task.status]})${task.result ? `\n  Résultat : ${task.result}` : ''}`;
        })
        .join('\n');
    },
  });

  const ownWorkspace = self.workspaceId;
  if (ownWorkspace) {
    tools.share_file = tool({
      description:
        "Envoie une copie d'un fichier ou d'un dossier de ton /workspace à un bot ou une équipe qui ne voit pas tes fichiers : elle arrive dans leur /workspace/inbox/, et le bot (ou le lead de l'équipe) est prévenu. Entre bots d'une même équipe, donne simplement le chemin.",
      inputSchema: z.object({
        path: z.string().describe('Chemin dans /workspace'),
        to: z.string().describe("Nom d'un bot ou d'une équipe"),
        note: z.string().max(2000).optional().describe("Ce que c'est, ce qu'il faut en faire"),
      }),
      execute: async ({ path: file, to, note }) => {
        const bot = await findBot(to).catch(() => null);
        const team = bot ? null : await findTeam(to);
        const workspaceId = bot ? bot.workspaceId : (team?.workspaceId ?? null);
        const name = bot?.name ?? `l'équipe ${team?.name}`;
        if (!workspaceId) throw new Error(`${name} n'a pas de fichiers.`);
        if (workspaceId === ownWorkspace) {
          throw new Error(
            `${name} voit déjà tes fichiers (même /workspace) : donne-lui le chemin.`,
          );
        }
        const lead = team?.leadBotId ? await findBot(team.leadBotId) : null;
        const recipient = bot ?? lead;
        if (recipient) await runtime.checkReach(self, recipient, ctx.depth);
        const entry = await ctx.files
          .copyInto(
            ownWorkspace,
            workspacePath(file),
            workspaceId,
            `inbox/${botFolder(self.name).split('/').at(-1)}`,
          )
          .catch(toolError);
        ctx.events.publish({
          type: 'workspace.changed',
          workspaceId,
          paths: [parentOf(entry.path)],
        });
        if (recipient) {
          await runtime.deliver(recipient.id, {
            from: self,
            kind: 'chat',
            text: `[Fichier partagé${team ? ` avec l'équipe ${team.name}` : ''}] /workspace/${entry.path}${note ? `\n${note}` : ''}`,
            meta: { depth: ctx.depth },
          });
        }
        return `Copié chez ${name} : /workspace/${entry.path}. ${recipient ? `${recipient.name} est prévenu.` : "L'équipe n'a pas de lead : personne n'est prévenu."}`;
      },
    });
  }

  tools.update_bot = tool({
    description:
      "Change ton rôle ou ta mission (ou ceux d'un bot de ton équipe si tu en es le lead ; le Chef : de n'importe quel bot).",
    inputSchema: z.object({
      bot: z.string().describe('Nom du bot (toi-même possible)'),
      role: z.string().min(1).max(120).optional(),
      mission: z.string().max(4000).optional(),
    }),
    execute: async ({ bot, role, mission }) => {
      const target = await findBot(bot);
      const allowed =
        self.isChef ||
        target.id === self.id ||
        (target.teamId !== null && (await ledTeams()).includes(target.teamId));
      if (!allowed) throw new Error(`Tu ne peux pas modifier ${target.name}.`);
      await ctx.bots.update(target.id, {
        ...(role ? { role } : {}),
        ...(mission !== undefined ? { mission } : {}),
      });
      return `${target.name} mis à jour.`;
    },
  });

  // Building the organisation: the Chef everywhere, a lead inside its team.
  const isLead = async () => (await ledTeams()).length > 0;

  if (self.isChef) {
    tools.create_team = tool({
      description:
        'Crée une équipe : elle a son PC partagé et son dossier de fichiers. Ensuite, crée ses bots avec create_bot (dont son lead). Crée une équipe pour un domaine durable, pas pour une tâche ponctuelle.',
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        mission: z.string().max(4000),
        isolated: z
          .boolean()
          .default(false)
          .describe(
            'Cloisonnée : seuls son lead et toi pouvez écrire à ses bots (données sensibles)',
          ),
      }),
      execute: async ({ name, mission, isolated }) => {
        const team = await org.createTeam({ name, mission, isolated }).catch(toolError);
        return `Équipe « ${team.name} » créée (son PC s'allumera au premier besoin). Crée maintenant ses bots avec create_bot.`;
      },
    });

    tools.move_bot = tool({
      description:
        "Change un bot d'équipe (ou le rend solo) : il travaille ensuite sur le PC de sa nouvelle équipe (ou un PC dédié) et son dossier le suit. S'il travaillait, il est interrompu.",
      inputSchema: z.object({
        bot: z.string().describe('Nom du bot'),
        team: z.string().describe("Nom de l'équipe ; « solo » pour un bot hors équipe"),
        computer: z.enum(['team', 'dedicated']).default('team'),
      }),
      execute: async ({ bot, team, computer }) => {
        const target = await findBot(bot);
        if (target.id === self.id) throw new Error("Tu restes dans l'équipe principale.");
        const destination = team.trim().toLowerCase() === 'solo' ? null : await findTeam(team);
        const moved = await runtime
          .moveBot(target.id, { teamId: destination?.id ?? null, computer })
          .catch(toolError);
        return `${moved.name} est maintenant ${destination ? `dans l'équipe ${destination.name}` : 'solo, avec son propre PC et ses fichiers'}${destination && computer === 'dedicated' ? ', sur un PC dédié' : ''}. Préviens-le de ce qui change pour lui.`;
      },
    });
  }

  if (self.isChef || (await isLead())) {
    tools.create_bot = tool({
      description: self.isChef
        ? "Crée un bot : dans une équipe (sur le PC de l'équipe, ou un PC dédié pour un travail lourd ou sensible) ou solo (son propre PC et ses propres fichiers). Donne-lui un rôle et une mission claire, puis écris-lui ou confie-lui une tâche. Réutilise plutôt les bots existants quand c'est possible."
        : "Crée un bot dans ton équipe (sur le PC de l'équipe, ou un PC dédié pour un travail lourd ou sensible). Donne-lui un rôle et une mission claire.",
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe('Prénom court et unique'),
        role: z.string().min(1).max(120).describe('Ex. « Veille concurrentielle »'),
        mission: z.string().max(4000),
        team: z
          .string()
          .optional()
          .describe(
            self.isChef ? "Nom de l'équipe ; « solo » pour un bot hors équipe" : 'Ton équipe',
          ),
        computer: z.enum(['team', 'dedicated']).default('team'),
        lead: z.boolean().default(false).describe("En faire le lead de l'équipe"),
      }),
      execute: async ({ name, role, mission, team, computer, lead }) => {
        let teamId: string | null;
        if (self.isChef) {
          teamId =
            team?.trim().toLowerCase() === 'solo'
              ? null
              : team
                ? (await findTeam(team)).id
                : (self.teamId ?? null);
        } else {
          const mine = await ledTeams();
          teamId = team ? (await findTeam(team)).id : (mine[0] ?? null);
          if (!teamId || !mine.includes(teamId)) {
            throw new Error('Tu ne peux créer des bots que dans ton équipe.');
          }
        }
        const created = await org
          .createBot(
            { name, role, mission, teamId, computer, lead: self.isChef ? lead : false },
            self.id,
          )
          .catch(toolError);
        const [home] = created.teamId
          ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, created.teamId))
          : [];
        return `${created.name} est créé${home ? ` dans l'équipe ${home.name}` : ' (solo)'}${computer === 'dedicated' || !home ? ', avec son propre PC' : ''}. Écris-lui ou confie-lui une tâche pour le lancer.`;
      },
    });
  }

  return tools;
}
