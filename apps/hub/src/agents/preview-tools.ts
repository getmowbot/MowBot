import type { CanvasContent } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { Db } from '../db/client';
import { HttpProblem } from '../http/problems';
import { hubTexts } from '../i18n';
import type { PreviewRow, PreviewService } from '../previews/service';

export interface PreviewToolContext {
  self: BotRow;
  computerId: string;
  previews: PreviewService;
  /** Starts the bot's computer if needed. */
  computer(): Promise<AgentClient>;
  /** Puts the preview's card in the bot's current answer. */
  showInChat(content: CanvasContent): Promise<void>;
  db: Db;
  timeZone: string;
}

export const SHARE_PREVIEW = 'share_preview';

const portSchema = z
  .number()
  .int()
  .min(1)
  .max(65_535)
  .describe('Le port où ton serveur de dev écoute sur ton PC (ex. 5173)');

/** `/admin?tab=2`, never `//other.site` or a full address. */
const pathSchema = z
  .string()
  .trim()
  .max(500)
  // No lookaround: some providers drop such patterns from tool schemas.
  .regex(/^\/([^/\s]\S*)?$/, 'un chemin qui commence par /, ex. /admin')
  .optional()
  .describe('La page à ouvrir, ex. /admin (par défaut /)');

const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/**
 * "18:42" in the hub's time zone, "jeu. 18:42" when it is not today: a preview shared at
 * 18:42 ends at 18:42 tomorrow, which must not read as now.
 */
export function timeOf(date: Date, timeZone: string, locale: string, now = new Date()): string {
  const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone });
  return date.toLocaleString(locale, {
    timeZone,
    ...(day(date) === day(now) ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One line per running preview of the PC, for the bot's prompt (no link: share_preview gives it). */
export function previewLines(rows: PreviewRow[], timeZone: string): string[] {
  return rows.map(
    (row) =>
      `- port ${row.port} « ${row.title} »${row.path === '/' ? '' : ` (${row.path})`}, servi sur le port ${row.publicPort} du hub jusqu'à ${timeOf(row.expiresAt, timeZone, 'fr-FR')}`,
  );
}

/**
 * A web page the bot builds on its PC, shown to the user: the hub serves the dev server on one
 * of its own ports, behind a secret link (phone, other computer, LAN or internet).
 */
export function buildPreviewTools(ctx: PreviewToolContext): ToolSet {
  const { self, computerId, previews } = ctx;
  return {
    [SHARE_PREVIEW]: tool({
      description:
        "Montre à l'utilisateur une page web que tu développes sur ton PC (un serveur de dev : Vite, Next, Astro, python -m http.server…) : le hub la sert sur un port de sa propre adresse, derrière un lien secret qui marche sur son téléphone comme sur son ordinateur, en réseau local comme depuis internet, rechargement à chaud (HMR) compris. Une carte avec un bouton Ouvrir s'affiche dans la conversation. Lance d'abord le serveur (en arrière-plan) ; il peut n'écouter que sur localhost. Partager à nouveau le même port garde le même lien et le prolonge de 24 h.",
      inputSchema: z.object({
        port: portSchema,
        title: z
          .string()
          .trim()
          .min(1)
          .max(80)
          .optional()
          .describe('Ce que c’est, en quelques mots (ex. « Site de la boulangerie »)'),
        path: pathSchema,
      }),
      execute: async ({ port, title, path }) => {
        await ctx.computer();
        const { row, token, created } = await previews
          .share({
            computerId,
            botId: self.id,
            port,
            title: title ?? `Port ${port}`,
            path: path ?? '/',
          })
          .catch(toolError);
        const base = previews.linkBase();
        const url = previews.url(row, token, base);
        const texts = await hubTexts(ctx.db);
        const until = timeOf(row.expiresAt, ctx.timeZone, texts.preview.locale);
        await ctx.showInChat({
          kind: 'card',
          title: row.title,
          subtitle: texts.preview.subtitle(`${base.hostname}:${row.publicPort}`, until),
          text: texts.preview.text,
          url,
          buttons: [{ label: texts.preview.open, url }],
        });
        return [
          `Aperçu ${created ? 'partagé' : 'prolongé'} : ${url}`,
          `(port ${port} de ton PC, servi sur le port ${row.publicPort} du hub, jusqu'à ${timeOf(row.expiresAt, ctx.timeZone, 'fr-FR')} ou jusqu'à ce que ton PC s'éteigne ou se mette en veille).`,
          "Une carte avec un bouton Ouvrir est affichée dans la conversation ; ce lien est secret : ne le donne qu'à l'utilisateur. Laisse ton serveur tourner tant qu'il regarde.",
        ].join('\n');
      },
    }),

    stop_preview: tool({
      description:
        "Arrête l'aperçu d'un port partagé avec share_preview : son lien ne marche plus. Ton serveur de dev, lui, continue de tourner (arrête-le avec bash si besoin).",
      inputSchema: z.object({ port: portSchema }),
      execute: async ({ port }) =>
        (await previews.stopPort(computerId, port))
          ? `Aperçu du port ${port} arrêté : son lien ne marche plus.`
          : `Aucun aperçu partagé pour le port ${port}.`,
    }),
  };
}
