import { type CanvasContent, canvasContentSchema, canvasSizeSchema } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import { HttpProblem } from '../http/problems';
import { type CanvasService, newItemId } from '../proactivity/canvases';
import type { WorkspaceFiles } from '../workspaces/files';
import { workspacePath } from './tools';

const imagePath = z
  .string()
  .max(500)
  .describe('Chemin d’une image dans /workspace (télécharge-la d’abord, ex. avec curl)');

/** A picture: a file of /workspace, or a web address. */
const pictureRef = z
  .string()
  .min(1)
  .max(2_000)
  .describe('Image : chemin dans /workspace, ou adresse https:// (une image du web)');

/** Opened on the user's phone or computer, not on the bot's PC. */
const webLink = z.url({ protocol: /^https?$/ }).max(2_000);

/** The tool that shows things in the conversation (drawn as part of the answer). */
export const SHOW_IN_CHAT = 'show_in_chat';

/** What a bot sends; the hub turns it into a canvas (ids for list items, camelCase…). */
export const contentSchema = z.discriminatedUnion('kind', [
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
    kind: z.literal('card'),
    title: z.string().min(1).max(120),
    subtitle: z
      .string()
      .max(160)
      .optional()
      .describe('« 49,90 € · Decathlon », « 12 min à pied »…'),
    text: z.string().max(2_000).optional().describe('Quelques lignes, en Markdown'),
    image: pictureRef.optional(),
    url: webLink.optional().describe('Ouvert quand on touche la carte'),
    buttons: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          url: webLink
            .optional()
            .describe("Ouvre cette page sur le téléphone ou l'ordinateur de l'utilisateur"),
          reply: z
            .string()
            .max(300)
            .optional()
            .describe('Ce que tu reçois quand il appuie (par défaut : le libellé)'),
        }),
      )
      .max(3)
      .optional()
      .describe('Jusqu’à 3 boutons, le premier mis en avant (ex. « Acheter », « Rien faire »)'),
  }),
  z.object({
    kind: z.literal('gallery'),
    images: z
      .array(
        z.object({
          src: pictureRef,
          caption: z.string().max(120).optional(),
          url: webLink.optional(),
        }),
      )
      .min(1)
      .max(12),
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

/** In the conversation, a bot can also present one of its files (checked and sized by the hub). */
const chatContentSchema = z.discriminatedUnion('kind', [
  ...contentSchema.options,
  z.object({
    kind: z.literal('file'),
    path: z
      .string()
      .min(1)
      .max(500)
      .describe('Fichier ou dossier de /workspace, ex. /workspace/outputs/rapport.pdf'),
    caption: z.string().max(300).optional().describe('Ce que c’est, en quelques mots'),
  }),
]);

/** `/workspace/a/b.png` → `a/b.png`. */
const workspaceRelative = (value: string | undefined) =>
  value?.replace(/^\/?workspace\/?/, '').replace(/^\/+/, '') || undefined;

/** Web addresses stay as they are; files are paths in the workspace. */
const picture = (value: string): string =>
  /^https?:\/\//i.test(value) ? value : (workspaceRelative(value) ?? value);

/**
 * Turns a bot's content into a canvas. A list keeps the ids (and the ticks) of items whose text
 * did not change, so updating a shopping list does not undo what the user ticked.
 */
export function toContent(
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
    case 'card':
      return canvasContentSchema.parse({
        ...input,
        image: input.image ? picture(input.image) : undefined,
        buttons: input.buttons ?? [],
      });
    case 'gallery':
      return canvasContentSchema.parse({
        kind: 'gallery',
        images: input.images.map((image) => ({ ...image, src: picture(image.src) })),
      });
  }
}

const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/**
 * What a bot shows: in the conversation (show_in_chat, the everyday way) or pinned on the
 * user's home page (canvas_set, only when the user wants it there).
 */
export function buildCanvasTools(ctx: {
  self: BotRow;
  canvases: CanvasService;
  /** Puts the content in the bot's current answer. */
  showInChat?: (content: CanvasContent) => Promise<void>;
  /** To present the bot's files. */
  files?: WorkspaceFiles;
}): ToolSet {
  const { self, canvases, showInChat, files } = ctx;
  const tools: ToolSet = {};

  if (showInChat) {
    tools[SHOW_IN_CHAT] = tool({
      description:
        "Montre quelque chose dans la conversation, là où tu en es de ta réponse, puis continue ton texte en dessous : une carte (card : image, titre, quelques mots, jusqu'à 3 boutons qui ouvrent une page sur le téléphone ou l'ordinateur de l'utilisateur, ou qui te répondent d'un clic), des images (gallery), un fichier ou un dossier de ton /workspace (file : aperçu, ouvrir, télécharger), un score, des chiffres, une note… Pour un produit, un lieu, un itinéraire (lien Google Maps), un article, une photo : c'est plus rapide à lire qu'un paragraphe. Images : un fichier de /workspace ou une adresse https.",
      inputSchema: z.object({ content: chatContentSchema }),
      execute: async ({ content }) => {
        if (content.kind !== 'file') {
          await showInChat(toContent(content, undefined));
          return 'Affiché dans la conversation.';
        }
        if (!self.workspaceId || !files) throw new Error("Tu n'as pas de fichiers à montrer.");
        const entry = await files.stat(self.workspaceId, workspacePath(content.path));
        await showInChat({
          kind: 'file',
          path: entry.path,
          name: entry.name,
          type: entry.type,
          size: entry.size,
          caption: content.caption,
        });
        return `${entry.type === 'directory' ? 'Dossier' : 'Fichier'} présenté dans la conversation (aperçu, ouvrir, télécharger).`;
      },
    });
  }

  tools.canvas_set = tool({
    description:
      "Épingle ou met à jour un canvas sur la page d'accueil de l'utilisateur : une carte qui suit dans la durée le résultat de ton travail (un score, une liste à cocher, quelques chiffres, une note). Seulement si l'utilisateur l'a demandé ou a accepté ta proposition : sa page d'accueil est à lui, ne la remplis pas d'office. Pour montrer un résultat ponctuel, utilise show_in_chat. Même `key` = même carte mise à jour : ne crée pas une nouvelle carte à chaque fois. Au plus 4 canvas par bot ; garde-les utiles et à jour, retire ceux qui ne servent plus. Préfère score/checklist/stats/note ; html seulement si rien d'autre ne convient. Pour une liste, lis-la d'abord (canvas_get) : l'utilisateur a pu cocher ou ajouter des éléments, et ce que tu envoies la remplace.",
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
