import { taskStatusSchema } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { cleanFocus, FOCUS_MAX } from '../bots/focus';
import { type BotRow, type BotService, botFolder } from '../bots/service';
import { type ConnectorService, usableBy } from '../connectors/service';
import type { Db } from '../db/client';
import { bots, computers, tasks, teams } from '../db/schema';
import type { EventBus } from '../events';
import { HttpProblem } from '../http/problems';
import type { PlanService } from '../org/plans';
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
  /** The teams' plans: a task can carry a step of one. */
  plans: PlanService;
  bots: BotService;
  files: WorkspaceFiles;
  events: EventBus;
  db: Db;
  /** The user's computers, for tasks done in one of their projects. */
  connectors?: ConnectorService;
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

/** What a message to another bot says in a few words: the user sees it folded in the conversation. */
const SUMMARY = z
  .string()
  .optional()
  .describe(
    "L'essentiel de ton message en quelques mots (10 au plus), sans salutation : c'est ce que l'utilisateur voit dans la conversation, le message entier s'ouvre d'un clic.",
  );

const summed = (summary: string | undefined) => {
  const text = summary?.replace(/\s+/g, ' ').trim();
  return text ? { summary: text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text } : {};
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

  /** The user's project a task is done in: the one named, or the giver's active project. */
  const taskProject = async (name: string | undefined, target: BotRow) => {
    const { connectors } = ctx;
    const wanted = name?.trim();
    if (!connectors || /^(aucun|none)$/i.test(wanted ?? '')) return null;
    const mine = await connectors.accessibleTo(self);
    const activeId = (await ctx.bots.row(self.id)).projectId;
    const found = wanted
      ? mine.find((p) => p.name.toLowerCase() === wanted.toLowerCase())
      : mine.find((p) => p.id === activeId);
    if (!found) {
      if (wanted) throw new Error(`Aucun projet « ${wanted} ». Regarde local_projects.`);
      return null;
    }
    if (!usableBy(found, target)) {
      throw new Error(
        `${target.name} n'a pas accès au projet ${found.name} : demande à l'utilisateur de le lui ouvrir (page Projets de l'app), ou confie la tâche hors projet (project « aucun »).`,
      );
    }
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
      const line = (bot: BotRow) => {
        // What it works on: its own words, else the task it is doing.
        const { focus } = ctx.bots.toBot(bot);
        return [
          `- ${bot.name}${bot.id === self.id ? ' (toi)' : ''} — ${bot.role}`,
          `, ${STATUS_LABELS[bot.status]}`,
          focus ? ` : « ${focus} »` : '',
          bot.computerId && pcKind.get(bot.computerId) === 'dedicated' ? ', PC dédié' : '',
          bot.mission ? `\n  Mission : ${bot.mission}` : '',
        ].join('');
      };
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
      summary: SUMMARY,
    }),
    execute: async ({ to, text, summary }) => {
      const target = await findBot(to);
      await runtime.checkReach(self, target, ctx.depth);
      await runtime.deliver(target.id, {
        from: self,
        kind: 'chat',
        text,
        meta: { depth: ctx.depth, ...summed(summary) },
      });
      return `Message envoyé à ${target.name}.`;
    },
  });

  tools.stop_bot = tool({
    description:
      "Arrête ce qu'un bot est en train de faire (il part dans la mauvaise direction, fait doublon, gaspille). Il garde une note de qui l'a arrêté et pourquoi, et ne reprend que quand on lui écrit : dis-lui ensuite quoi faire (send_message) si besoin. Le Chef peut arrêter tous les bots ; un lead, ceux de son équipe ; les autres, les bots de leur équipe.",
    inputSchema: z.object({
      bot: z.string().describe('Nom du bot'),
      reason: z.string().min(1).max(300).describe('Pourquoi, en une phrase'),
    }),
    execute: async ({ bot, reason }) => {
      const target = await findBot(bot);
      if (target.id === self.id) throw new Error('Pour t’arrêter, termine simplement ton tour.');
      const sameTeam = target.teamId !== null && target.teamId === self.teamId;
      const leads = target.teamId !== null && (await ledTeams()).includes(target.teamId);
      if (!self.isChef && (target.isChef || !(sameTeam || leads))) {
        throw new Error(
          `Tu ne peux pas arrêter ${target.name} : demande-le au Chef ou au lead de son équipe.`,
        );
      }
      return (await runtime.stopBy(self, target, reason))
        ? `J’ai arrêté ${target.name}.`
        : `${target.name} ne travaillait pas.`;
    },
  });

  tools.ask_bot = tool({
    description:
      'Pose une question à un autre bot et attend sa réponse (quelques minutes au plus). Pour ce dont tu as besoin tout de suite ; sinon send_message ou assign_task.',
    inputSchema: z.object({
      to: z.string().describe('Nom du bot'),
      question: z.string().min(1).max(8000),
      summary: SUMMARY,
    }),
    execute: async ({ to, question, summary }, { abortSignal }) => {
      const target = await findBot(to);
      const answer = await runtime.ask(self, target, question, ctx.depth, abortSignal, summary);
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
      project: z
        .string()
        .optional()
        .describe(
          "Projet de l'utilisateur où faire la tâche (il devient le projet actif du bot) : par défaut ton projet actif ; « aucun » pour une tâche hors projet",
        ),
      step: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Numéro de l'étape du plan de son équipe que porte cette tâche : l'étape lui revient et suit la tâche",
        ),
    }),
    execute: async ({ to, title, details, project, step }) => {
      const target = await findBot(to);
      // A task to itself wakes the bot up too: it counts against the same limits.
      await runtime.checkReach(self, target, ctx.depth, { allowSelf: true });
      if (step !== undefined) {
        if (!target.teamId) {
          throw new Error(
            `${target.name} n'est dans aucune équipe : pas de plan où relier la tâche.`,
          );
        }
        if (!(await ctx.plans.keeps(target.teamId, self))) {
          throw new Error(
            "Seuls le lead de l'équipe et le Chef relient une tâche à son plan : confie-la sans step.",
          );
        }
      }
      const where = await taskProject(project, target);
      if (where && target.projectId !== where.id) {
        await ctx.bots.update(target.id, { projectId: where.id });
      }
      const task = await ctx.tasks
        .create(
          {
            assignee: target,
            title,
            details: [details, where ? `Projet : ${where.name}` : ''].filter(Boolean).join('\n\n'),
            ...(step !== undefined && target.teamId
              ? { step: { teamId: target.teamId, number: step } }
              : {}),
          },
          self,
          ctx.depth,
        )
        .catch(toolError);
      return `Tâche créée (id ${task.id}) pour ${target.name}${where ? `, dans le projet ${where.name} (son projet actif)` : ''}${step !== undefined ? `, elle porte l'étape ${step} du plan` : ''}.`;
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
        .describe('Ce que tu as fait (et où sont les fichiers, s’il y en a), ou ce qui te bloque'),
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

  tools.set_focus = tool({
    description:
      "Dit en une phrase ce sur quoi tu travailles (« Je développe la page d'accueil », « Je vérifie mes maquettes ») : l'utilisateur et les autres bots la voient à côté de ton nom. Mets-la quand tu te lances dans un travail, change-la quand tu passes à un autre, efface-la (text vide) quand il est fini.",
    inputSchema: z.object({
      text: z
        .string()
        .max(FOCUS_MAX * 3)
        .describe(
          `À la première personne, au présent, dans la langue de l'utilisateur, ${FOCUS_MAX} caractères au plus ; vide pour l'effacer`,
        ),
    }),
    execute: async ({ text }) => {
      const focus = cleanFocus(text);
      await ctx.bots.update(self.id, { focus });
      return focus ? `C'est affiché : « ${focus} ».` : "C'est effacé.";
    },
  });

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
        "Crée une équipe : elle a son PC partagé et son dossier de fichiers. Ensuite, crée ses bots avec create_bot (dont son lead). Crée une équipe pour un domaine durable, pas pour une tâche ponctuelle. Son PC : un bureau Ubuntu (par défaut : navigateur visible, l'utilisateur peut prendre la main) ou la ligne de commande seule (plus léger : code, scripts, données, web sans fenêtre) ; gpu pour lui donner les cartes graphiques de la machine (calcul, IA, vidéo).",
      inputSchema: z.object({
        name: z.string().min(1).max(60),
        mission: z.string().max(4000),
        isolated: z
          .boolean()
          .default(false)
          .describe(
            'Cloisonnée : seuls son lead et toi pouvez écrire à ses bots (données sensibles)',
          ),
        pc: z
          .enum(['bureau', 'terminal'])
          .default('bureau')
          .describe('Son PC : un bureau Ubuntu, ou la ligne de commande seule'),
        gpu: z
          .boolean()
          .default(false)
          .describe('Lui donner les cartes graphiques NVIDIA de la machine'),
      }),
      execute: async ({ name, mission, isolated, pc, gpu }) => {
        const team = await org
          .createTeam({
            name,
            mission,
            isolated,
            computer: {
              system: pc === 'terminal' ? 'terminal' : 'desktop',
              ...(gpu ? { gpus: 'all' as const } : {}),
            },
          })
          .catch(toolError);
        return `Équipe « ${team.name} » créée, avec ${pc === 'terminal' ? 'un PC en ligne de commande' : 'un PC avec bureau'}${gpu ? ' et les cartes graphiques' : ''} (il s'allumera au premier besoin). Crée maintenant ses bots avec create_bot.`;
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
    tools.clear_conversations = tool({
      description:
        "Vide les conversations des bots d'une équipe (ou de quelques bots) pour repartir de zéro, par exemple avant de passer à un autre projet : ils s'arrêtent et oublient leurs échanges, leurs fichiers et leurs tâches restent. Toute l'équipe : son plan part aussi (écris le nouveau ensuite). Ta propre conversation n'est pas touchée. Le Chef : tous les bots ; un lead : ceux de son équipe. Dis à l'utilisateur ce que tu as vidé.",
      inputSchema: z.object({
        team: z.string().optional().describe("Nom de l'équipe dont vider toutes les conversations"),
        bots: z.array(z.string()).max(30).optional().describe('Ou seulement ces bots (noms)'),
      }),
      execute: async ({ team, bots: names }) => {
        const led = self.isChef ? [] : await ledTeams();
        const allowed = (teamId: string | null) =>
          self.isChef || (teamId !== null && led.includes(teamId));
        if (team) {
          const found = await findTeam(team);
          if (!allowed(found.id)) throw new Error(`Tu ne peux vider que ton équipe.`);
          const planned = Boolean(await ctx.plans.get(found.id));
          const cleared = await runtime.clearTeam(found.id, self.id);
          const plan = planned ? ' Son plan est effacé : écris le nouveau avec plan_set.' : '';
          return cleared.length
            ? `Conversations vidées : ${cleared.join(', ')}.${plan}`
            : `Aucun autre bot dans l'équipe ${found.name}.${plan}`;
        }
        if (!names?.length) throw new Error('Donne team ou bots.');
        const cleared: string[] = [];
        for (const name of names) {
          const target = await findBot(name);
          if (target.id === self.id) continue;
          if (!allowed(target.teamId)) throw new Error(`Tu ne peux pas vider ${target.name}.`);
          await runtime.clear(target.id);
          cleared.push(target.name);
        }
        return cleared.length ? `Conversations vidées : ${cleared.join(', ')}.` : 'Rien à vider.';
      },
    });

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
