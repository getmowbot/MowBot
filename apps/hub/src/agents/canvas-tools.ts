import { type CanvasContent, canvasSizeSchema } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import { HttpProblem } from '../http/problems';
import { type CanvasService, newItemId } from '../proactivity/canvases';

const imagePath = z
  .string()
  .max(500)
  .describe('Chemin d’une image dans /workspace (télécharge-la d’abord, ex. avec curl)');

/** What a bot sends; the hub turns it into a canvas (ids for list items, camelCase…). */
const contentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('score'),
    home: z.object({ name: z.string().min(1).max(60), logo: imagePath.optional() }),
    away: z.object({ name: z.string().min(1).max(60), logo: imagePath.optional() }),
    home_score: z.number().int().min(0).nullable().describe('null avant le match'),
    away_score: z.number().int().min(0).nullable(),
    status: z.string().max(40).describe('« Terminé », « Mi-temps », « Dim. 20:45 »…'),
    detail: z.string().max(80).optional().describe('« Ligue 1 · 9e journée »'),
  }),
  z.object({
    kind: z.literal('checklist'),
    items: z
      .array(z.object({ text: z.string().min(1).max(200), done: z.boolean().optional() }))
      .max(60),
  }),
  z.object({
    kind: z.literal('stats'),
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          value: z.string().min(1).max(30),
          hint: z.string().max(60).optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  z.object({
    kind: z.literal('note'),
    markdown: z.string().max(4000),
    image: imagePath.optional(),
  }),
  z.object({
    kind: z.literal('html'),
    html: z
      .string()
      .max(60_000)
      .describe(
        'HTML et CSS autonomes, sans JavaScript (bloqué) ni accès réseau : images en data:, graphiques en SVG en ligne. Fond transparent, texte clair ; hauteur fixe selon la taille (s 200 px, m 260 px, l 360 px).',
      ),
  }),
]);

/** `/workspace/a/b.png` → `a/b.png`. */
const workspaceRelative = (value: string | undefined) =>
  value?.replace(/^\/?workspace\/?/, '').replace(/^\/+/, '') || undefined;

/**
 * Turns a bot's content into a canvas. A list keeps the ids (and the ticks) of items whose text
 * did not change, so updating a shopping list does not undo what the user ticked.
 */
function toContent(
  input: z.infer<typeof contentSchema>,
  previous: CanvasContent | undefined,
): CanvasContent {
  switch (input.kind) {
    case 'score':
      return {
        kind: 'score',
        home: { name: input.home.name, logo: workspaceRelative(input.home.logo) },
        away: { name: input.away.name, logo: workspaceRelative(input.away.logo) },
        homeScore: input.home_score,
        awayScore: input.away_score,
        status: input.status,
        detail: input.detail,
      };
    case 'checklist': {
      const before = previous?.kind === 'checklist' ? previous.items : [];
      return {
        kind: 'checklist',
        items: input.items.map((item) => {
          const same = before.find((b) => b.text.toLowerCase() === item.text.toLowerCase());
          return {
            id: same?.id ?? newItemId(),
            text: item.text,
            done: item.done ?? same?.done ?? false,
          };
        }),
      };
    }
    case 'note':
      return { kind: 'note', markdown: input.markdown, image: workspaceRelative(input.image) };
    case 'stats':
      return { kind: 'stats', items: input.items };
    case 'html':
      return { kind: 'html', html: input.html };
  }
}

const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/** Cards a bot pins on the user's home page, to show the result of its work at a glance. */
export function buildCanvasTools(ctx: { self: BotRow; canvases: CanvasService }): ToolSet {
  const { self, canvases } = ctx;
  const tools: ToolSet = {};

  tools.canvas_set = tool({
    description:
      "Publie ou met à jour un canvas sur la page d'accueil de l'utilisateur : une carte qui montre d'un coup d'œil le résultat de ton travail (un score, une liste à cocher, quelques chiffres, une note). Même `key` = même carte mise à jour : ne crée pas une nouvelle carte à chaque fois. Au plus 4 canvas par bot ; garde-les utiles et à jour, retire ceux qui ne servent plus. Préfère score/checklist/stats/note ; html seulement si rien d'autre ne convient. Pour une liste, lis-la d'abord (canvas_get) : l'utilisateur a pu cocher ou ajouter des éléments, et ce que tu envoies la remplace.",
    inputSchema: z.object({
      key: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-z0-9-]+$/)
        .describe('Identifiant stable, ex. « psg-dernier-match », « liste-de-courses »'),
      title: z.string().min(1).max(60),
      size: canvasSizeSchema
        .optional()
        .describe('s (petit, par défaut), m (moyen), l (toute la largeur)'),
      content: contentSchema,
    }),
    execute: async ({ key, title, size, content }) => {
      const existing = await canvases.byKey(self.id, key);
      const { canvas, created } = await canvases
        .publishFromBot(self.id, {
          key,
          title,
          size,
          content: toContent(content, existing?.content),
        })
        .catch(toolError);
      if (canvas.hidden) {
        return "Canvas mis à jour, mais l'utilisateur l'a retiré de sa page d'accueil : il ne le voit pas. Ne le recrée pas sous une autre clé, sauf s'il te le demande.";
      }
      return `Canvas « ${canvas.title} » ${created ? "ajouté à la page d'accueil" : 'mis à jour'}.`;
    },
  });

  tools.canvas_get = tool({
    description:
      "Lit un de tes canvas tel qu'il est maintenant (par exemple ce que l'utilisateur a coché dans une liste).",
    inputSchema: z.object({ key: z.string().min(1).max(60) }),
    execute: async ({ key }) => {
      const canvas = await canvases.byKey(self.id, key);
      if (!canvas) return `Aucun canvas « ${key} ».`;
      if (canvas.content.kind === 'checklist') {
        return [
          `${canvas.title}${canvas.hidden ? ' (retiré par l’utilisateur)' : ''} :`,
          ...canvas.content.items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`),
        ].join('\n');
      }
      return JSON.stringify({ title: canvas.title, hidden: canvas.hidden, ...canvas.content });
    },
  });

  tools.canvas_list = tool({
    description: 'Tes canvas sur la page d’accueil.',
    inputSchema: z.object({}),
    execute: async () => {
      const mine = await canvases.list(self.id);
      if (mine.length === 0) return 'Aucun canvas.';
      return mine
        .map(
          (c) =>
            `- ${c.key} : ${c.title} (${c.content.kind}, taille ${c.size}${c.hidden ? ', retiré par l’utilisateur' : ''}, mis à jour ${c.updatedAt.toISOString()})`,
        )
        .join('\n');
    },
  });

  tools.canvas_remove = tool({
    description: 'Retire un de tes canvas de la page d’accueil.',
    inputSchema: z.object({ key: z.string().min(1).max(60) }),
    execute: async ({ key }) => {
      const canvas = await canvases.byKey(self.id, key);
      if (!canvas) return `Aucun canvas « ${key} ».`;
      await canvases.remove(canvas.id);
      return `Canvas « ${canvas.title} » retiré.`;
    },
  });

  return tools;
}
