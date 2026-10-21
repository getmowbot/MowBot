import { type ToolSet, tool } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { ConnectorRow, ConnectorService, ProjectRow } from '../connectors/service';
import type { Db } from '../db/client';
import { questions } from '../db/schema';
import { hubTexts } from '../i18n';
import type { QuestionService } from '../proactivity/questions';
import type { WorkspaceFiles } from '../workspaces/files';
import { pullProject, pushProject } from './project-sync';
import { clip } from './tools';

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

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

/** For the bot, when the project's computer cannot be reached now. */
export const OFFLINE_HINT =
  "son ordinateur est hors ligne : tu n'y accèdes pas tant que l'utilisateur n'a pas ouvert l'app MowBot desktop.";

const intentSchema = z
  .string()
  .max(80)
  .optional()
  .describe("Ce que tu fais, en quelques mots, pour l'utilisateur (ex. « Lance les tests »)");

/**
 * Tools on the folders the user shared from their own computer (projects), through the desktop
 * app: files freely, commands with the user's approval unless the project is in auto mode.
 */
export function buildLocalTools(ctx: {
  bot: BotRow;
  db: Db;
  connectors: ConnectorService;
  questions: QuestionService;
  projects: ProjectRow[];
  machines: Map<string, ConnectorRow>;
  files: WorkspaceFiles;
  /** The project the bot works in now (the user may change it while the bot works). */
  activeProjectId(): Promise<string | null>;
  /** The bot picks the project it works in (null: none). */
  setActiveProject(projectId: string | null): Promise<void>;
}): ToolSet {
  const { bot, connectors, projects, machines } = ctx;
  if (projects.length === 0) return {};
  const names = projects.map((p) => p.name).join(', ');

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
  const call = async <T>(
    name: string | undefined,
    op: Parameters<ConnectorService['request']>[1],
    args: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    const project = await resolve(name);
    return { project, data: await connectors.request<T>(project, op, args, timeoutMs) };
  };

  return {
    local_projects: tool({
      description:
        "Liste les projets que l'utilisateur a partagés depuis son ordinateur (app MowBot desktop) : dossiers où tu peux lire, écrire, chercher et lancer des commandes avec les outils local_*.",
      inputSchema: z.object({}),
      execute: async () => {
        const activeId = await ctx.activeProjectId();
        return projects
          .map((p) => {
            const machine = machines.get(p.connectorId);
            const where = machine
              ? `${machine.hostname ?? machine.name}${machine.os ? `, ${machine.os}` : ''}${machine.shell ? `, commandes en ${machine.shell}` : ''}`
              : 'ordinateur inconnu';
            const online = connectors.isOnline(p.connectorId) ? 'en ligne' : 'hors ligne';
            const mode =
              p.mode === 'auto' ? 'commandes libres' : "commandes avec l'accord de l'utilisateur";
            return `- ${p.name} : ${p.path} (${where}) · ${online} · ${mode}${p.id === activeId ? ' · projet actif' : ''}`;
          })
          .join('\n');
      },
    }),

    local_use_project: tool({
      description:
        "Choisit le projet où tu travailles (le projet actif) : les outils local_* y vont quand tu ne précises pas project, et l'utilisateur le voit dans la conversation. Sers-t'en quand il te dit sur quel projet il travaille. Vide : plus de projet actif.",
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
        return `Projet actif : ${row.name} (${place}).${online ? '' : ` Attention, ${OFFLINE_HINT}`}`;
      },
    }),

    local_list: tool({
      description:
        "Liste un dossier d'un projet local (chemin relatif à sa racine, vide = racine).",
      inputSchema: z.object({ project: projectSchema, path: z.string().default('') }),
      execute: async ({ project, path }) => {
        const { data } = await call<{
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
        "Lit un fichier texte d'un projet local, par tranches de lignes (offset : première ligne lue, 1 par défaut ; limit : 2000 par défaut).",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      }),
      execute: async ({ project, path, offset, limit }) => {
        const { data } = await call<{ text: string; totalLines: number; truncated: boolean }>(
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
        "Écrit (ou remplace) un fichier texte dans un projet local, en créant les dossiers manquants. Pour changer une partie d'un fichier existant, préfère local_edit.",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        content: z.string(),
      }),
      execute: async ({ project, path, content }) => {
        const { project: row, data } = await call<{ size: number }>(project, 'write', {
          path: relative(path),
          content,
        });
        return `Écrit : ${row.name}/${relative(path)} (${data.size} octets)`;
      },
    }),

    local_edit: tool({
      description:
        "Remplace un passage exact d'un fichier d'un projet local. old_text doit apparaître une seule fois (sinon all: true pour tout remplacer) : copie-le tel quel depuis local_read.",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().min(1),
        old_text: z.string().min(1),
        new_text: z.string(),
        all: z.boolean().default(false),
      }),
      execute: async ({ project, path, old_text, new_text, all }) => {
        const { project: row, data } = await call<{ replaced: number }>(project, 'edit', {
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
        "Trouve des fichiers d'un projet local par motif glob (ex. src/**/*.ts, **/package.json), en ignorant ce que .gitignore exclut.",
      inputSchema: z.object({
        project: projectSchema,
        pattern: z.string().min(1),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      execute: async ({ project, pattern, limit }) => {
        const { data } = await call<{ paths: string[]; truncated: boolean }>(project, 'find', {
          pattern,
          limit,
        });
        if (data.paths.length === 0) return 'Aucun fichier.';
        return `${data.paths.join('\n')}${data.truncated ? '\n[… d’autres fichiers : affine le motif]' : ''}`;
      },
    }),

    local_search: tool({
      description:
        "Cherche une expression régulière dans les fichiers d'un projet local (comme grep, en ignorant .gitignore) : chemin, ligne et texte de chaque résultat.",
      inputSchema: z.object({
        project: projectSchema,
        pattern: z.string().min(1).describe('Expression régulière (syntaxe Rust regex)'),
        path: z.string().optional().describe('Dossier où chercher (défaut : tout le projet)'),
        glob: z.string().optional().describe('Seulement ces fichiers, ex. *.ts'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ project, pattern, path, glob, limit }) => {
        const { data } = await call<{
          matches: { path: string; line: number; text: string }[];
          truncated: boolean;
        }>(project, 'search', { pattern, path: path ? relative(path) : undefined, glob, limit });
        if (data.matches.length === 0) return 'Aucun résultat.';
        const lines = data.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
        return `${lines.join('\n')}${data.truncated ? '\n[… d’autres résultats : affine la recherche]' : ''}`;
      },
    }),

    local_pull: tool({
      description:
        "Copie un projet local (ou un de ses dossiers) sur ton PC, dans /workspace/projects/<projet>, pour le lancer, l'installer, le tester ou le modifier avec bash. Respecte .gitignore ; une nouvelle copie ne transfère que ce qui a changé et garde tes propres modifications.",
      inputSchema: z.object({
        project: projectSchema,
        path: z.string().optional().describe('Seulement ce dossier du projet (défaut : tout)'),
      }),
      execute: async ({ project, path }) =>
        pullProject(
          { bot, files: ctx.files, connectors },
          await resolve(project),
          path ? relative(path).replace(/\/+$/, '') : '',
        ),
    }),

    local_push: tool({
      description:
        "Rapporte les changements faits dans ta copie (/workspace/projects/<projet>) sur l'ordinateur de l'utilisateur. Dépôt git : une branche mowbot/… (fichiers modifiés, ajoutés hors .gitignore, supprimés), son dossier n'est pas touché, il relit et fusionne quand il veut. Pas de dépôt git : les fichiers modifiés et ajoutés sont écrits directement dans son dossier (sauf ceux qu'il a changés entre-temps ; rien n'est supprimé).",
      inputSchema: z.object({
        project: projectSchema,
        message: z
          .string()
          .min(1)
          .max(2000)
          .describe('Message du commit (dépôt git) : ce que tu as changé et pourquoi'),
      }),
      execute: async ({ project, message }) =>
        pushProject({ bot, files: ctx.files, connectors }, await resolve(project), message),
    }),

    local_exec: tool({
      description:
        "Lance une commande dans un projet local, sur l'ordinateur de l'utilisateur (le shell est indiqué par local_projects : PowerShell sous Windows). Sauf en mode auto, l'utilisateur doit l'accepter : la question lui est posée et sa réponse t'arrive en message.",
      inputSchema: z.object({
        intent: intentSchema,
        project: projectSchema,
        command: z.string().min(1),
        cwd: z.string().optional().describe('Dossier du projet où la lancer (défaut : sa racine)'),
        timeout_seconds: z.number().int().min(1).max(600).default(120),
      }),
      execute: async ({ project, command, cwd, timeout_seconds }) => {
        const row = await resolve(project);
        if (row.mode !== 'auto' && !(await connectors.consumeGrant(row.id, bot.id, command))) {
          await askApproval(ctx, row, command);
          throw new Error(
            "Cette commande attend l'accord de l'utilisateur : la question lui est posée. Sa réponse t'arrivera en message ; s'il accepte, relance exactement la même commande.",
          );
        }
        const timeoutMs = timeout_seconds * 1000;
        return connectors.request<ExecResult>(
          row,
          'exec',
          { command, cwd: cwd ? relative(cwd) : undefined, timeoutMs },
          timeoutMs + 15_000,
        );
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
