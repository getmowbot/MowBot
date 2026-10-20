import path from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import { botFolder } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { EventBus } from '../events';
import type { WorkspaceFiles } from '../workspaces/files';
import { parentOf } from '../workspaces/files';
import {
  closeOpened,
  inventory,
  isTabId,
  isWindowId,
  openedBy,
  openUrlScript,
  parseProcesses,
  processesScript,
} from './desktop';
import type { FileLocks, ScreenLeases } from './shared-pc';

/** How a bot shares its computer with others. */
export interface SharedPc {
  computerId: string;
  screen: ScreenLeases;
  locks: FileLocks;
  /** The other bots working on this computer. */
  neighbours(): Promise<BotRow[]>;
}

/** What a bot's tools act on. */
export interface ToolContext {
  botId: string;
  botName: string;
  workspaceId: string | null;
  files: WorkspaceFiles;
  events: EventBus;
  shared: SharedPc | null;
  /** Starts the bot's computer if needed and returns its agent. */
  computer: (() => Promise<AgentClient>) | null;
  /** Screenshots (base64 PNG) to show the model at its next step. */
  pendingImages: string[];
}

const MAX_TOOL_TEXT = 16_000;

/** Keeps the end of long outputs (where errors usually are). */
export function clip(text: string, max = MAX_TOOL_TEXT): string {
  return text.length <= max
    ? text
    : `[… ${text.length - max} caractères coupés …]\n${text.slice(-max)}`;
}

/** `/workspace/a/b` → `a/b`; anything outside /workspace is refused. */
function workspacePath(input: string): string {
  const resolved = path.posix.resolve('/workspace', input.replaceAll('\\', '/'));
  if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) {
    throw new Error(
      'Seuls les fichiers de /workspace sont accessibles avec cet outil ; utilise bash pour le reste.',
    );
  }
  return resolved.slice('/workspace'.length).replace(/^\//, '');
}

/** Shown to the user instead of the raw call ("Clic (749, 690)"). */
const intentSchema = z
  .string()
  .max(80)
  .optional()
  .describe(
    "Ce que tu fais, en quelques mots, pour l'utilisateur (ex. « Télécharge le programme TV », « Accepte les cookies »)",
  );

const pointSchema = {
  x: z.number().int().min(0).max(1279).optional().describe('Abscisse en pixels (0-1279)'),
  y: z.number().int().min(0).max(799).optional().describe('Ordonnée en pixels (0-799)'),
};

/** Tools of a bot. Without a computer it only gets file tools (if it has a workspace). */
export function buildTools(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {};
  const { workspaceId, files, events, shared } = ctx;
  const self = { id: ctx.botId, name: ctx.botName };
  /** The display is shared: wait for the bot using it, then hold it for a little while. */
  const takeScreen = (signal?: AbortSignal) =>
    shared ? shared.screen.acquire(shared.computerId, self, signal) : Promise.resolve();

  if (workspaceId) {
    tools.list_files = tool({
      description: "Liste le contenu d'un dossier de /workspace.",
      inputSchema: z.object({ path: z.string().default('/workspace') }),
      execute: async ({ path: dir }) => {
        const listing = await files.list(workspaceId, workspacePath(dir));
        return (
          listing.entries
            .map(
              (e) =>
                `${e.type === 'directory' ? '📁' : '📄'} ${e.name}${e.type === 'file' ? ` (${e.size} o)` : ''}`,
            )
            .join('\n') || '(dossier vide)'
        );
      },
    });

    tools.read_file = tool({
      description: 'Lit un fichier texte de /workspace (tronqué au-delà de 200 Ko).',
      inputSchema: z.object({ path: z.string().describe('Chemin, ex. /workspace/inbox/brief.md') }),
      execute: async ({ path: file }) => {
        const { text, truncated, size } = await files.readText(workspaceId, workspacePath(file));
        return truncated ? `${text}\n[… tronqué, ${size} octets au total]` : text;
      },
    });

    tools.write_file = tool({
      description:
        'Écrit (ou remplace) un fichier texte dans /workspace, en créant les dossiers manquants.',
      inputSchema: z.object({
        path: z.string().describe('Chemin, ex. /workspace/outputs/rapport.md'),
        content: z.string(),
      }),
      execute: async ({ path: file, content }) => {
        const rel = workspacePath(file);
        shared?.locks.assertWritable(workspaceId, rel, ctx.botId);
        const entry = await files.writeFile(workspaceId, rel, content);
        events.publish({ type: 'workspace.changed', workspaceId, paths: [parentOf(entry.path)] });
        return `Écrit : /workspace/${entry.path} (${entry.size} octets)`;
      },
    });
  }

  const computer = ctx.computer;
  if (!computer) return tools;

  tools.bash = tool({
    description:
      'Exécute une commande bash sur ton PC Linux (utilisateur bot, sudo sans mot de passe, dossier courant /workspace). Pour un programme graphique ou long, lance-le en arrière-plan avec `&` ou `nohup`.',
    inputSchema: z.object({
      intent: intentSchema,
      command: z.string().min(1),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
    }),
    execute: async ({ command, timeout_seconds }) => {
      const agent = await computer();
      // Tagged so pc_status can tell which bot started which process.
      const result = await agent.exec(`export MOWBOT_BOT=${ctx.botId}\n${command}`, {
        timeoutMs: timeout_seconds * 1000,
      });
      if (workspaceId) events.publish({ type: 'workspace.changed', workspaceId, paths: [''] });
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
  });

  tools.open_url = tool({
    description:
      'Ouvre une adresse dans le Google Chrome de ton PC, à la place de ta page courante (ton onglet est réutilisé). new_tab: true garde ta page et ouvre un onglet de plus.',
    inputSchema: z.object({ url: z.url(), new_tab: z.boolean().default(false) }),
    execute: async ({ url, new_tab }, { abortSignal }) => {
      const agent = await computer();
      await takeScreen(abortSignal);
      const result = await agent.exec(openUrlScript(ctx.botId, url, new_tab), {
        timeoutMs: 45_000,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Chrome did not open the page');
      return `Ouvert dans Chrome : ${url}. Prends une capture pour voir la page.`;
    },
  });

  tools.screenshot = tool({
    description: "Capture l'écran de ton PC (1280×800) pour voir ce qui s'y passe.",
    inputSchema: z.object({}),
    execute: async (_, { abortSignal }) => {
      const agent = await computer();
      await takeScreen(abortSignal);
      const png = await agent.screenshot();
      let saved: string | null = null;
      if (workspaceId) {
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const entry = await files.writeFile(
          workspaceId,
          `${botFolder(ctx.botName)}/captures/${name}`,
          png,
        );
        saved = entry.path;
      }
      // The image itself is attached to the next step as a user message (see runtime):
      // chat-completions APIs reject images inside tool results.
      ctx.pendingImages.push(png.toString('base64'));
      return { saved };
    },
    toModelOutput: () => ({
      type: 'text',
      value: "Capture prise : l'image est jointe au message suivant.",
    }),
  });

  tools.computer = tool({
    description:
      "Agit sur l'écran de ton PC : clic, double clic, clic droit, déplacement, saisie de texte, touches (ex. 'ctrl+l', 'Return'), défilement, glisser-déposer. Refusé si l'utilisateur a pris la main.",
    inputSchema: z.object({
      intent: intentSchema,
      action: z.enum([
        'click',
        'double_click',
        'right_click',
        'move',
        'type',
        'key',
        'scroll',
        'drag',
      ]),
      ...pointSchema,
      text: z.string().optional().describe('Texte à taper (action type)'),
      keys: z
        .string()
        .optional()
        .describe('Touches xdotool, ex. ctrl+l, Return, Escape (action key)'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      amount: z.number().int().min(1).max(20).optional(),
      to_x: z.number().int().min(0).max(1279).optional(),
      to_y: z.number().int().min(0).max(799).optional(),
    }),
    execute: async (input, { abortSignal }) => {
      const agent = await computer();
      await takeScreen(abortSignal);
      const at = input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : {};
      switch (input.action) {
        case 'click':
        case 'double_click':
        case 'right_click':
          await agent.input({
            action: 'click',
            ...at,
            button: input.action === 'right_click' ? 'right' : 'left',
            double: input.action === 'double_click',
          });
          break;
        case 'move':
          if (!('x' in at)) throw new Error('move demande x et y');
          await agent.input({ action: 'move', ...at });
          break;
        case 'type':
          if (!input.text) throw new Error('type demande text');
          await agent.input({ action: 'type', text: input.text });
          break;
        case 'key':
          if (!input.keys) throw new Error('key demande keys');
          await agent.input({ action: 'key', keys: input.keys });
          break;
        case 'scroll':
          await agent.input({
            action: 'scroll',
            ...at,
            direction: input.direction ?? 'down',
            amount: input.amount ?? 3,
          });
          break;
        case 'drag':
          if (!('x' in at) || input.to_x === undefined || input.to_y === undefined) {
            throw new Error('drag demande x, y, to_x et to_y');
          }
          await agent.input({ action: 'drag', from: at, to: { x: input.to_x, y: input.to_y } });
          break;
      }
      return 'Fait.';
    },
  });

  tools.list_windows = tool({
    description:
      "Liste ce qui est ouvert sur ton PC : onglets de Chrome et fenêtres d'applications, en indiquant ceux que tu as ouverts.",
    inputSchema: z.object({}),
    execute: async () => {
      const inv = await inventory(await computer(), ctx.botId);
      const mine = (id: string) => (inv.mine.has(id) ? ' — ouvert par toi' : '');
      return [
        'Onglets de Chrome :',
        ...(inv.tabs.length
          ? inv.tabs.map((t) => `- [${t.id}] ${t.title || '(sans titre)'} — ${t.url}${mine(t.id)}`)
          : ['- aucun']),
        "Fenêtres d'applications :",
        ...(inv.windows.length
          ? inv.windows.map((w) => `- [${w.id}] ${w.name} (${w.className})${mine(w.id)}`)
          : ['- aucune']),
      ].join('\n');
    },
  });

  tools.close_windows = tool({
    description:
      "Ferme des onglets de Chrome et des fenêtres d'applications. Sans ids, range tout ce que tu as ouvert (onglets et applis) ; avec ids (donnés par list_windows), ferme ceux-là.",
    inputSchema: z.object({
      ids: z.array(z.string()).max(50).optional().describe('Identifiants donnés par list_windows'),
    }),
    execute: async ({ ids }, { abortSignal }) => {
      const agent = await computer();
      // Closing an application window goes through the keyboard (alt+F4).
      await takeScreen(abortSignal);
      const inv = await inventory(agent, ctx.botId);
      const target = ids?.length
        ? {
            tabs: ids.filter((id) => isTabId(id) && inv.tabs.some((t) => t.id === id)),
            windows: ids.filter((id) => isWindowId(id) && inv.windows.some((w) => w.id === id)),
          }
        : openedBy(inv);
      const asked = [...target.tabs, ...target.windows];
      if (asked.length === 0) {
        return ids?.length
          ? 'Rien à fermer : ces identifiants ne sont plus ouverts.'
          : "Rien à ranger : tu n'as rien laissé d'ouvert.";
      }
      const closed = await closeOpened(agent, ctx.botId, target);
      const tabs = target.tabs.filter((id) => closed.has(id)).length;
      const windows = target.windows.filter((id) => closed.has(id)).length;
      const stuck = target.windows.filter((id) => !closed.has(id));
      return [
        `Fermé : ${tabs} onglet(s), ${windows} fenêtre(s).`,
        stuck.length
          ? `Toujours ouvertes (une confirmation attend peut-être, prends une capture) : ${stuck.join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
    },
  });

  if (!shared) return tools;

  tools.pc_status = tool({
    description:
      "Qui fait quoi sur le PC que tu partages : les autres bots, qui a l'écran, les onglets et processus de chacun, les fenêtres, les fichiers verrouillés.",
    inputSchema: z.object({}),
    execute: async () => {
      const agent = await computer();
      const neighbours = await shared.neighbours();
      const names = new Map([
        [ctx.botId, 'toi'],
        ...neighbours.map((b) => [b.id, b.name] as const),
      ]);
      const who = (id: string) => names.get(id) ?? 'un bot supprimé';
      const [inv, procs] = await Promise.all([
        inventory(agent, ctx.botId),
        agent.exec(processesScript(), { timeoutMs: 20_000 }).then((r) => parseProcesses(r.stdout)),
      ]);
      const screen = shared.screen.holder(shared.computerId);
      const locks = workspaceId ? shared.locks.list(workspaceId) : [];
      return [
        `Bots sur ce PC : ${neighbours.map((b) => `${b.name} (${b.statusDetail ?? b.status})`).join(', ') || 'toi seul'}.`,
        `Écran : ${screen ? (screen.botId === ctx.botId ? 'à toi' : `utilisé par ${screen.botName}`) : 'libre'}.`,
        'Onglets de Chrome :',
        ...(inv.tabs.length
          ? inv.tabs.map(
              (t) =>
                `- ${t.title || '(sans titre)'} — ${t.url}${inv.owners.has(t.id) ? ` (${who(inv.owners.get(t.id) as string)})` : ''}`,
            )
          : ['- aucun']),
        'Processus lancés par les bots :',
        ...(procs.length
          ? procs.map((p) => `- ${who(p.botId)} : [${p.pid}] ${p.command}`)
          : ['- aucun']),
        "Fenêtres d'applications :",
        ...(inv.windows.length
          ? inv.windows.map((w) => `- ${w.name} (${w.className})`)
          : ['- aucune']),
        `Fichiers verrouillés : ${locks.map((l) => `${l.path} (${l.botName})`).join(', ') || 'aucun'}.`,
      ].join('\n');
    },
  });

  if (workspaceId) {
    tools.lock_file = tool({
      description:
        "Réserve un fichier de /workspace pendant que tu le modifies : les autres bots ne peuvent plus l'écrire avec write_file. Libéré par unlock_file ou à la fin de ton tour.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: file }) => {
        const rel = workspacePath(file);
        shared.locks.lock(workspaceId, rel, self);
        return `/workspace/${rel} est à toi jusqu'à unlock_file ou la fin de ton tour.`;
      },
    });

    tools.unlock_file = tool({
      description: 'Libère un fichier réservé avec lock_file.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: file }) => {
        const rel = workspacePath(file);
        return shared.locks.unlock(workspaceId, rel, ctx.botId)
          ? `/workspace/${rel} est libéré.`
          : `Tu n'avais pas réservé /workspace/${rel}.`;
      },
    });
  }

  return tools;
}
