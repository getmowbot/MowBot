import path from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { botFolder } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { EventBus } from '../events';
import type { WorkspaceFiles } from '../workspaces/files';
import { parentOf } from '../workspaces/files';

/** What a bot's tools act on. */
export interface ToolContext {
  botName: string;
  workspaceId: string | null;
  files: WorkspaceFiles;
  events: EventBus;
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

/**
 * Opens a tab in the computer's shared Chrome through its local DevTools endpoint (waiting
 * for Chrome after a cold boot), brings it to the front, and leaves the page time to load.
 * Falls back to launching Chrome when DevTools never answers.
 */
export function openUrlScript(url: string): string {
  const quoted = `'${url.replaceAll("'", "'\\''")}'`;
  return [
    `URL=${quoted}`,
    'DEVTOOLS=http://127.0.0.1:9222',
    'for i in $(seq 1 75); do curl -fs -o /dev/null "$DEVTOOLS/json/version" && break; sleep 0.2; done',
    'if curl -fs -o /dev/null "$DEVTOOLS/json/version"; then',
    `  ID=$(curl -fs -X PUT "$DEVTOOLS/json/new?$URL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')`,
    '  curl -fs -o /dev/null "$DEVTOOLS/json/activate/$ID"',
    'else',
    '  nohup google-chrome --user-data-dir="$HOME/.config/mowbot-chrome" "$URL" >/dev/null 2>&1 &',
    '  sleep 3',
    'fi',
    'xdotool search --onlyvisible --class google-chrome windowactivate >/dev/null 2>&1 || true',
    'sleep 1.5',
  ].join('\n');
}

const pointSchema = {
  x: z.number().int().min(0).max(1279).optional().describe('Abscisse en pixels (0-1279)'),
  y: z.number().int().min(0).max(799).optional().describe('Ordonnée en pixels (0-799)'),
};

/** Tools of a bot. Without a computer it only gets file tools (if it has a workspace). */
export function buildTools(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {};
  const { workspaceId, files, events } = ctx;

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
        const entry = await files.writeFile(workspaceId, workspacePath(file), content);
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
      command: z.string().min(1),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
    }),
    execute: async ({ command, timeout_seconds }) => {
      const agent = await computer();
      const result = await agent.exec(command, { timeoutMs: timeout_seconds * 1000 });
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
      'Ouvre une adresse dans le Google Chrome de ton PC (nouvel onglet), visible sur le bureau.',
    inputSchema: z.object({ url: z.url() }),
    execute: async ({ url }) => {
      const agent = await computer();
      const result = await agent.exec(openUrlScript(url), { timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Chrome did not open the page');
      return `Ouvert dans Chrome : ${url}. Prends une capture pour voir la page.`;
    },
  });

  tools.screenshot = tool({
    description: "Capture l'écran de ton PC (1280×800) pour voir ce qui s'y passe.",
    inputSchema: z.object({}),
    execute: async () => {
      const agent = await computer();
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
    execute: async (input) => {
      const agent = await computer();
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

  return tools;
}
