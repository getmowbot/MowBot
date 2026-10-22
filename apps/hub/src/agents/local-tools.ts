import { type ToolSet, tool } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { MirrorRow, MirrorService, SyncReport } from '../connectors/mirror';
import type { ConnectorRow, ConnectorService, ProjectRow } from '../connectors/service';
import type { Db } from '../db/client';
import { questions } from '../db/schema';
import { hubTexts } from '../i18n';
import type { QuestionService } from '../proactivity/questions';
import { clip } from './tools';

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Paths are relative to the project's folder, with `/`. */
const relative = (input: string) => input.replaceAll('\\', '/').replace(/^(\.\/|\/)+/, '');

const projectSchema = z
  .string()
  .optional()
  .describe('Nom du projet (voir local_projects) ; par défaut le projet actif');

/** "PC-de-Joris, linux, en ligne": where a project is, and whether bots can reach it now. */
export function projectPlace(machine: ConnectorRow | undefined, online: boolean): string {
  return [
    machine?.hostname ?? machine?.name ?? 'ordinateur inconnu',
    machine?.os,
    online ? 'en ligne' : 'hors ligne',
  ]
    .filter(Boolean)
    .join(', ');
}

/** For the bot, when the project's computer cannot be reached now and it has no mirror. */
export const OFFLINE_HINT =
  "son ordinateur est hors ligne : tu n'y accèdes pas tant que l'utilisateur n'a pas ouvert l'app MowBot desktop.";

/** Where a mirror stands, for the bot: "à jour", "3 changements en attente de l'ordinateur"… */
export function mirrorState(row: MirrorRow, online: boolean): string {
  const parts: string[] = [];
  switch (row.status) {
    case 'waiting':
      parts.push("première copie en attente de l'ordinateur (hors ligne)");
      break;
    case 'syncing':
      parts.push('synchronisation en cours');
      break;
    case 'too_big':
      parts.push(`pas de miroir : ${row.error ?? 'projet trop gros'}`);
      break;
    case 'error':
      parts.push(`synchro en erreur (${row.error ?? '?'})`);
      break;
    case 'pending':
      parts.push(
        `${plural(row.pending, 'changement')} en attente de l'ordinateur${online ? ` (${row.error ?? 'à réessayer'})` : ' (hors ligne)'}`,
      );
      break;
    default:
      parts.push(online ? 'à jour' : "à jour (l'ordinateur est hors ligne)");
  }
  if (row.conflicts.length) parts.push(plural(row.conflicts.length, 'conflit'));
  return parts.join(', ');
}

/** What a reconcile did, for the bot. */
function reportText(report: SyncReport | null, name: string): string {
  if (!report) return `Pas de miroir pour « ${name} » en ce moment.`;
  const where = `/workspace/${report.folder}`;
  if (report.status === 'too_big') return report.error ?? 'Projet trop gros pour un miroir.';
  if (!report.online) {
    return report.status === 'waiting'
      ? `${where} : la première copie se fera quand l'ordinateur de l'utilisateur sera en ligne. Tu peux déjà y créer des fichiers.`
      : `L'ordinateur de l'utilisateur est hors ligne : ${where} garde ton travail (${plural(report.pending, 'changement')} en attente), il arrivera dans son dossier dès qu'il se reconnecte, sans rien faire de ta part.`;
  }
  const lines = [
    `${where} synchronisé avec son dossier : ${plural(report.sent, 'fichier')} envoyé${report.sent > 1 ? 's' : ''}, ${plural(report.received, 'reçu')}, ${report.deletedThere + report.deletedHere} supprimé${report.deletedThere + report.deletedHere > 1 ? 's' : ''}.`,
  ];
  if (report.conflicts.length) {
    lines.push(
      `Conflits (lui et vous avez changé les mêmes fichiers) : ${report.conflicts.slice(0, 10).join(', ')}. Sa version est gardée ; la vôtre est dans /workspace/projects/_conflicts/.`,
    );
  }
  if (report.restored) {
    lines.push(
      `${plural(report.restored, 'fichier')} supprimés d'un coup dans le miroir : remis depuis son ordinateur par sécurité.`,
    );
  }
  if (report.pending) {
    lines.push(`${plural(report.pending, 'changement')} pas encore passé : ${report.error ?? '?'}`);
  }
  return lines.join('\n');
}

const intentSchema = z
  .string()
  .max(80)
  .optional()
  .describe("Ce que tu fais, en quelques mots, pour l'utilisateur (ex. « Lance les tests »)");

/**
 * Tools on the folders the user shared from their own computer (projects). A project is mirrored
 * in the bot's workspace (`/workspace/projects/<name>`), where the bot works with its usual tools
 * while the hub keeps both sides in sync; commands can still run on the user's computer. A
 * project the user keeps out of the mirrors is worked on directly, while its computer is online.
 */
export function buildLocalTools(ctx: {
  bot: BotRow;
  db: Db;
  connectors: ConnectorService;
  mirrors?: MirrorService;
  questions: QuestionService;
  projects: ProjectRow[];
  machines: Map<string, ConnectorRow>;
  /** The project the bot works in now (the user may change it while the bot works). */
  activeProjectId(): Promise<string | null>;
  /** The bot picks the project it works in (null: none). */
  setActiveProject(projectId: string | null): Promise<void>;
}): ToolSet {
  const { bot, connectors, mirrors, projects, machines } = ctx;
  if (projects.length === 0) return {};
  const names = projects.map((p) => p.name).join(', ');
  /**
   * Mirrored for this bot, in its workspace: unless the user turned it off for the project, or
   * the project is too big (bots then work in it directly).
   */
  const mirrored = (p: ProjectRow) =>
    Boolean(mirrors && bot.workspaceId && p.mirror) &&
    mirrors?.mirrorIn(p.id, bot.workspaceId)?.status !== 'too_big';

  const find = (name: string): ProjectRow => {
    const wanted = fold(name);
    const found =
      projects.find((p) => p.id === name) ??
      projects.find((p) => fold(p.name) === wanted) ??
      projects.find((p) => fold(p.name).includes(wanted));
    if (!found) throw new Error(`Aucun projet « ${name} ». Projets : ${names}.`);
    return found;
  };
  /** The project named, else the active one, else the only one there is. */
  const resolve = async (name: string | undefined): Promise<ProjectRow> => {
    if (name?.trim()) return find(name.trim());
    const activeId = await ctx.activeProjectId();
    const active =
      projects.find((p) => p.id === activeId) ?? (projects.length === 1 && projects[0]);
    if (active) return active;
    throw new Error(
      `Aucun projet actif : précise project (${names}), ou choisis-en un avec local_use_project.`,
    );
  };
  /** Its mirror in the bot's workspace, made if it has none yet. */
  const mirrorOf = async (p: ProjectRow): Promise<MirrorRow | null> =>
    mirrored(p) && mirrors && bot.workspaceId ? mirrors.ensure(p.id, bot.workspaceId) : null;
  /** Synced now (bounded: a first copy of a big project goes on in the background). */
  const syncNow = async (mirror: MirrorRow, waitMs = 120_000): Promise<SyncReport | null> => {
    if (!mirrors) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((done) => {
      timer = setTimeout(() => done(null), waitMs);
    });
    try {
      return await Promise.race([mirrors.syncNow(mirror.id), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** Files of a project the user keeps out of the mirrors: on their computer, directly. */
  const direct = async <T>(
    name: string | undefined,
    op: Parameters<ConnectorService['request']>[1],
    args: Record<string, unknown>,
  ) => {
    const project = await resolve(name);
    if (mirrored(project)) {
      const mirror = await mirrorOf(project);
      throw new Error(
        `« ${project.name} » est en miroir dans /workspace/${mirror?.folder ?? 'projects/…'} : lis, cherche et modifie ses fichiers là, avec read_file, write_file et bash. Le hub les synchronise avec son dossier.`,
      );
    }
    return { project, data: await connectors.request<T>(project, op, args) };
  };

  const tools: ToolSet = {
    local_projects: tool({
      description:
        "Liste les projets que l'utilisateur a partagés depuis son ordinateur (app MowBot desktop), avec leur miroir dans ton workspace (/workspace/projects/…), où tu travailles sur leurs fichiers.",
      inputSchema: z.object({}),
      execute: async () => {
        const activeId = await ctx.activeProjectId();
        return projects
          .map((p) => {
            const machine = machines.get(p.connectorId);
            const where = machine
              ? `${machine.hostname ?? machine.name}${machine.os ? `, ${machine.os}` : ''}${machine.shell ? `, commandes en ${machine.shell}` : ''}`
              : 'ordinateur inconnu';
            const online = connectors.isOnline(p.connectorId);
            const mode =
              p.mode === 'auto' ? 'commandes libres' : "commandes avec l'accord de l'utilisateur";
            const mirror = mirrors?.mirrorIn(p.id, bot.workspaceId);
            const copy = !mirrored(p)
              ? 'sans miroir (fichiers directement sur son ordinateur, outils local_*)'
              : mirror
                ? `miroir /workspace/${mirror.folder} (${mirrorState(mirror, online)})`
                : 'miroir créé dès que tu y travailles (local_use_project ou local_sync)';
            return `- ${p.name} : ${p.path} (${where}) · ${online ? 'en ligne' : 'hors ligne'} · ${mode} · ${copy}${p.id === activeId ? ' · projet actif' : ''}`;
          })
          .join('\n');
      },
    }),

    local_use_project: tool({
      description:
        "Choisit le projet où tu travailles (le projet actif) : son miroir est dans ton workspace (/workspace/projects/<projet>), les outils local_* y vont quand tu ne précises pas project, et l'utilisateur le voit dans la conversation. Sers-t'en quand il te dit sur quel projet il travaille. Vide : plus de projet actif.",
      inputSchema: z.object({
        project: z.string().describe("Nom du projet ; vide pour n'en garder aucun"),
      }),
      execute: async ({ project }) => {
        if (!project.trim()) {
          await ctx.setActiveProject(null);
          return 'Plus de projet actif.';
        }
        const row = find(project.trim());
        await ctx.setActiveProject(row.id);
        const online = connectors.isOnline(row.connectorId);
        const place = projectPlace(machines.get(row.connectorId), online);
        const mirror = await mirrorOf(row);
        if (!mirror) {
          return `Projet actif : ${row.name} (${place}), sans miroir : ses fichiers sont sur son ordinateur (local_read, local_edit…).${online ? '' : ` Attention, ${OFFLINE_HINT}`}`;
        }
        const report = await syncNow(mirror, 60_000);
        return `Projet actif : ${row.name} (${place}). Travaille dans /workspace/${mirror.folder}.\n${report ? reportText(report, row.name) : 'Première copie en cours : elle continue en arrière-plan.'}`;
      },
    }),

    local_sync: tool({
      description:
        "Synchronise tout de suite le miroir d'un projet (/workspace/projects/<projet>) avec le dossier de l'utilisateur, dans les deux sens, et dit où il en est. La synchro se fait seule en continu : sers-t'en pour vérifier que ton travail est arrivé chez lui, ou pour avoir le miroir d'un projet qui n'est pas ton projet actif.",
      inputSchema: z.object({ project: projectSchema }),
      execute: async ({ project }) => {
        const row = await resolve(project);
        if (!row.mirror || !mirrors || !bot.workspaceId) {
          return `« ${row.name} » n'a pas de miroir${row.mirror ? ' (tu n’as pas de workspace)' : " : l'utilisateur l'a désactivé pour ce projet"}. Travaille directement sur son ordinateur (local_read, local_edit…).`;
        }
        const mirror = await mirrors.ensure(row.id, bot.workspaceId);
        if (!mirror) return `Pas de miroir pour « ${row.name} » en ce moment.`;
        return reportText(await syncNow(mirror), row.name);
      },
    }),

    local_exec: tool({
      description:
        "Lance une commande dans un projet, sur l'ordinateur de l'utilisateur (shell indiqué par local_projects : PowerShell sous Windows), quand il est en ligne : son dossier a d'abord ton travail du miroir, et ce que la commande change revient dans le miroir. Sauf en mode auto, l'utilisateur doit l'accepter : la question lui est posée et sa réponse t'arrive en message. Hors ligne, lance-la sur ton PC dans le miroir (bash).",
      inputSchema: z.object({
        intent: intentSchema,
        project: projectSchema,
        command: z.string().min(1),
        cwd: z.string().optional().describe('Dossier du projet où la lancer (défaut : sa racine)'),
        timeout_seconds: z.number().int().min(1).max(600).default(120),
      }),
      execute: async ({ project, command, cwd, timeout_seconds }) => {
        const row = await resolve(project);
        const mirror = await mirrorOf(row);
        if (!connectors.isOnline(row.connectorId)) {
          throw new Error(
            mirror
              ? `L'ordinateur de l'utilisateur est hors ligne : lance la commande sur ton PC, dans /workspace/${mirror.folder} (bash). Ton travail y est gardé et arrivera chez lui à sa reconnexion.`
              : `Pour l'instant, ${OFFLINE_HINT}`,
          );
        }
        if (row.mode !== 'auto' && !(await connectors.consumeGrant(row.id, bot.id, command))) {
          await askApproval(ctx, row, command);
          throw new Error(
            "Cette commande attend l'accord de l'utilisateur : la question lui est posée. Sa réponse t'arrivera en message ; s'il accepte, relance exactement la même commande.",
          );
        }
        // His folder has the work of the mirror before the command runs…
        if (mirror) await syncNow(mirror);
        const timeoutMs = timeout_seconds * 1000;
        const result = await connectors.request<ExecResult>(
          row,
          'exec',
          { command, cwd: cwd ? relative(cwd) : undefined, timeoutMs },
          timeoutMs + 15_000,
        );
        // …and what it changed there (formatting, generated files) comes back.
        if (mirror) await syncNow(mirror, 60_000);
        return result;
      },
      toModelOutput: ({ output }) => ({
        type: 'text',
        value: [
          `exit code: ${output.exitCode ?? 'aucun'}${output.timedOut ? ' (délai dépassé, processus tué)' : ''}`,
          output.stdout ? `stdout:\n${clip(output.stdout)}` : '',
          output.stderr ? `stderr:\n${clip(output.stderr, 4_000)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }),
    }),
  };

  // A project kept out of the mirrors (or a bot without workspace): its files, directly.
  if (projects.every(mirrored)) return tools;
  return {
    ...tools,
    local_list: tool({
      description:
        "Liste un dossier d'un projet sans miroir, sur l'ordinateur de l'utilisateur (chemin relatif à sa racine, vide = racine).",
      inputSchema: z.object({ project: projectSchema, path: z.string().default('') }),
      execute: async ({ project, path }) => {
        const { data } = await direct<{
          entries: { name: string; type: 'file' | 'directory'; size: number }[];
        }>(project, 'list', { path: relative(path) });
        return (
          data.entries
            .map((e) => (e.type === 'directory' ? `📁 ${e.name}/` : `📄 ${e.name} (${e.size} o)`))
            .join('\n') || '(dossier vide)'
        );
      },
    }),

    local_read: tool({
      description:
        "Lit un fichier texte d'un projet sans miroir, par tranches de lignes (offset : première ligne lue, 1 par défaut ; limit : 2000 par défaut).",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      }),
      execute: async ({ project, path, offset, limit }) => {
        const { data } = await direct<{ text: string; totalLines: number; truncated: boolean }>(
          project,
          'read',
          { path: relative(path), offset, limit },
        );
        const from = offset ?? 1;
        return data.truncated
          ? `${data.text}\n[… lignes ${from} à ${from + data.text.split('\n').length - 1} sur ${data.totalLines} : continue avec offset]`
          : data.text;
      },
    }),

    local_write: tool({
      description:
        "Écrit (ou remplace) un fichier texte dans un projet sans miroir, en créant les dossiers manquants. Pour changer une partie d'un fichier existant, préfère local_edit.",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        content: z.string(),
      }),
      execute: async ({ project, path, content }) => {
        const { project: row, data } = await direct<{ size: number }>(project, 'write', {
          path: relative(path),
          content,
        });
        return `Écrit : ${row.name}/${relative(path)} (${data.size} octets)`;
      },
    }),

    local_edit: tool({
      description:
        "Remplace un passage exact d'un fichier d'un projet sans miroir. old_text doit apparaître une seule fois (sinon all: true pour tout remplacer) : copie-le tel quel depuis local_read.",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        old_text: z.string().min(1),
        new_text: z.string(),
        all: z.boolean().default(false),
      }),
      execute: async ({ project, path, old_text, new_text, all }) => {
        const { project: row, data } = await direct<{ replaced: number }>(project, 'edit', {
          path: relative(path),
          old: old_text,
          new: new_text,
          all,
        });
        return `Modifié : ${row.name}/${relative(path)} (${data.replaced} remplacement${data.replaced > 1 ? 's' : ''})`;
      },
    }),

    local_find: tool({
      description:
        "Trouve des fichiers d'un projet sans miroir par motif glob (ex. src/**/*.ts, **/package.json), en ignorant ce que .gitignore exclut.",
      inputSchema: z.object({
        project: projectSchema,
        pattern: z.string().min(1),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      execute: async ({ project, pattern, limit }) => {
        const { data } = await direct<{ paths: string[]; truncated: boolean }>(project, 'find', {
          pattern,
          limit,
        });
        if (data.paths.length === 0) return 'Aucun fichier.';
        return `${data.paths.join('\n')}${data.truncated ? '\n[… d’autres fichiers : affine le motif]' : ''}`;
      },
    }),

    local_search: tool({
      description:
        "Cherche une expression régulière dans les fichiers d'un projet sans miroir (comme grep, en ignorant .gitignore) : chemin, ligne et texte de chaque résultat.",
      inputSchema: z.object({
        project: projectSchema,
        pattern: z.string().min(1).describe('Expression régulière (syntaxe Rust regex)'),
        path: z.string().optional().describe('Dossier où chercher (défaut : tout le projet)'),
        glob: z.string().optional().describe('Seulement ces fichiers, ex. *.ts'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ project, pattern, path, glob, limit }) => {
        const { data } = await direct<{
          matches: { path: string; line: number; text: string }[];
          truncated: boolean;
        }>(project, 'search', { pattern, path: path ? relative(path) : undefined, glob, limit });
        if (data.matches.length === 0) return 'Aucun résultat.';
        const lines = data.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        return `${lines.join('\n')}${data.truncated ? '\n[… d’autres résultats : affine la recherche]' : ''}`;
      },
    }),
  };
}

/** Asks the user once to let the bot run this command (an open question is not asked again). */
async function askApproval(
  ctx: { bot: BotRow; db: Db; questions: QuestionService; machines: Map<string, ConnectorRow> },
  row: ProjectRow,
  command: string,
): Promise<void> {
  const [open] = await ctx.db
    .select({ id: questions.id })
    .from(questions)
    .where(
      and(
        eq(questions.botId, ctx.bot.id),
        eq(questions.status, 'open'),
        sql`${questions.projectCommand}->>'projectId' = ${row.id}`,
        sql`${questions.projectCommand}->>'command' = ${command}`,
      ),
    )
    .limit(1);
  if (open) return;
  const texts = await hubTexts(ctx.db);
  const machine = ctx.machines.get(row.connectorId);
  await ctx.questions.ask(
    ctx.bot,
    texts.commandAsk(ctx.bot.name, row.name, machine?.hostname ?? machine?.name ?? '', command),
    [...texts.commandAnswers],
    { projectCommand: { projectId: row.id, command } },
  );
}
