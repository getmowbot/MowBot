import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { WebService } from '../web/service';

const INTENT = z
  .string()
  .max(120)
  .optional()
  .describe(
    "Ce que tu cherches, en quelques mots que l'utilisateur voit pendant que tu travailles",
  );

/**
 * The web from the hub, without the bot's computer: a search, then the pages it found read as
 * text. For a session, clicks or JavaScript, the browser of its PC (browser_*).
 */
export function buildWebTools(web: WebService): ToolSet {
  return {
    web_search: tool({
      description:
        "Cherche sur le web, depuis le hub, sans allumer ton PC : les résultats (titre, adresse, extrait). Pour une recherche simple, une info, une vérification. Lis ensuite une page avec web_read. Pour ce qui demande d'être connecté, de cliquer ou du JavaScript, utilise le navigateur de ton PC.",
      inputSchema: z.object({
        intent: INTENT,
        query: z.string().min(1).max(400).describe('La recherche, comme dans un moteur'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Nombre de résultats (6 par défaut)'),
      }),
      execute: async ({ query, count }) => {
        const results = await web.search(query, count);
        if (results.length === 0) return `Aucun résultat pour « ${query} ».`;
        return results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
          .join('\n');
      },
    }),
    web_read: tool({
      description:
        'Lit une page publique du web depuis le hub, sans allumer ton PC : son texte principal (titres, paragraphes, listes, liens), par morceaux. Une longue page se lit en plusieurs fois avec offset. Ne lit ni les pages qui demandent une connexion, ni les adresses locales (pour un serveur de ton PC : bash ou le navigateur).',
      inputSchema: z.object({
        intent: INTENT,
        url: z.url().describe('Adresse de la page (http ou https)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Où reprendre une longue page (donné par la lecture précédente)'),
      }),
      execute: async ({ url, offset }) => {
        const page = await web.read(url, offset ?? 0);
        return [
          `${page.title || page.url}\n${page.url}`,
          page.text || '(page sans texte)',
          page.next !== null
            ? `[Suite : web_read avec offset ${page.next} (${page.total} caractères en tout)]`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      },
    }),
  };
}
