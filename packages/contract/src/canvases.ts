import { z } from 'zod';

/**
 * Canvases: what bots pin on the home page, as cards. A few kinds, all drawn by the apps in
 * their own style (so the page stays tidy); `html` is the escape hatch, shown in a sandbox.
 * Images are paths in the bot's workspace (bots download pictures there first); cards and
 * galleries also take web addresses. The same kinds show inside conversations.
 */

const workspacePath = z.string().trim().min(1).max(500);

export const scoreTeamSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Logo, as a path in the bot's workspace. */
  logo: workspacePath.optional(),
});

/** An image: a path in the bot's workspace, or a web address. */
const imageSchema = z.string().trim().min(1).max(2_000);

/** Opened on the user's own device (phone, computer), never on a bot's PC. */
const webLinkSchema = z.url({ protocol: /^https?$/ }).max(2_000);

/**
 * A button of a card. `url`: opens that page on the user's device; `reply`: sent to the bot as
 * the user's answer (both may be set: "Acheter" opens the shop and tells the bot).
 */
export const cardButtonSchema = z.object({
  label: z.string().trim().min(1).max(40),
  url: webLinkSchema.optional(),
  reply: z.string().trim().min(1).max(300).optional(),
});
export type CardButton = z.infer<typeof cardButtonSchema>;

export const canvasContentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('note'),
    /** Markdown. */
    markdown: z.string().max(4000),
    image: workspacePath.optional(),
  }),
  z.object({
    kind: z.literal('score'),
    home: scoreTeamSchema,
    away: scoreTeamSchema,
    homeScore: z.number().int().min(0).max(999).nullable(),
    awayScore: z.number().int().min(0).max(999).nullable(),
    /** "Terminé", "Mi-temps", "Dim. 20:45"… */
    status: z.string().trim().max(40),
    /** "Ligue 1 · 9e journée". */
    detail: z.string().trim().max(80).optional(),
  }),
  z.object({
    kind: z.literal('stats'),
    items: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(40),
          value: z.string().trim().min(1).max(30),
          hint: z.string().trim().max(60).optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  z.object({
    kind: z.literal('checklist'),
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          text: z.string().trim().min(1).max(200),
          done: z.boolean(),
        }),
      )
      .max(60),
  }),
  z.object({
    kind: z.literal('html'),
    /** A self-contained page (inline CSS, images as data: URIs); shown without scripts or network. */
    html: z.string().max(60_000),
  }),
  /** A product, a place, a link, a route: an image, a title, a few words, up to 3 buttons. */
  z.object({
    kind: z.literal('card'),
    title: z.string().trim().min(1).max(120),
    /** "49,90 € · Decathlon", "12 min à pied"… */
    subtitle: z.string().trim().max(160).optional(),
    /** Markdown. */
    text: z.string().max(2_000).optional(),
    image: imageSchema.optional(),
    /** Opened when the card itself is tapped. */
    url: webLinkSchema.optional(),
    buttons: z.array(cardButtonSchema).max(3).default([]),
  }),
  /** A file or folder of the bot's workspace, presented with a preview, to open or download. */
  z.object({
    kind: z.literal('file'),
    /** Path in the bot's workspace. */
    path: workspacePath,
    name: z.string().trim().min(1).max(255),
    type: z.enum(['file', 'directory']),
    size: z.number().int().nonnegative(),
    /** A few words about it. */
    caption: z.string().trim().max(300).optional(),
  }),
  /** Pictures side by side (a photo, products to compare, screenshots). */
  z.object({
    kind: z.literal('gallery'),
    images: z
      .array(
        z.object({
          src: imageSchema,
          caption: z.string().trim().max(120).optional(),
          url: webLinkSchema.optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
]);
export type CanvasContent = z.infer<typeof canvasContentSchema>;
export type CanvasKind = CanvasContent['kind'];

export const canvasSizeSchema = z.enum(['s', 'm', 'l']);
export type CanvasSize = z.infer<typeof canvasSizeSchema>;

export const canvasSchema = z.object({
  id: z.uuid(),
  botId: z.uuid(),
  /** The bot's name for it, stable across updates ("psg-dernier-match"). */
  key: z.string(),
  title: z.string(),
  size: canvasSizeSchema,
  content: canvasContentSchema,
  /** Order on the home page (the user's). */
  position: z.number().int(),
  /** Removed from the home page by the user: kept, but not shown. */
  hidden: z.boolean(),
  /** Folded by the user: only its title shows (same on every device). */
  collapsed: z.boolean(),
  updatedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type Canvas = z.infer<typeof canvasSchema>;

export const canvasListSchema = z.object({ items: z.array(canvasSchema) });
export const canvasIdParamsSchema = z.object({ id: z.uuid() });

/** What the user changes: layout and visibility (the content is the bot's). */
export const canvasUpdateSchema = z.object({
  size: canvasSizeSchema.optional(),
  hidden: z.boolean().optional(),
  collapsed: z.boolean().optional(),
});

export const canvasOrderSchema = z.object({ ids: z.array(z.uuid()).max(100) });

export const checklistItemCreateSchema = z.object({ text: z.string().trim().min(1).max(200) });
export const checklistItemUpdateSchema = z.object({
  text: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
});
export const checklistItemParamsSchema = z.object({
  id: z.uuid(),
  itemId: z.string().min(1).max(40),
});

/** The user pressed a card's button that answers the bot. */
export const canvasPressSchema = z.object({ button: z.number().int().min(0).max(2) });
