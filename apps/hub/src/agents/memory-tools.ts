import { MEMORY_TEXT_MAX, memoryKindSchema } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import { HttpProblem } from '../http/problems';
import { MEMORY_KIND_LABELS, type MemoryService } from '../memory/service';

const toolError = (error: unknown): never => {
  if (error instanceof HttpProblem) throw new Error(error.message);
  throw error;
};

/** "rappelle-toi mon code…": secrets go to the vault, never to the memory. */
const SECRET =
  /\b(mot de passe|password|passcode|code (pin|secret|2fa|de vérification)|cvv|iban|token|clé api|api key)\b/i;

/**
 * The organisation's memory of the user, for every bot: what it heard that may serve elsewhere
 * (remember), what it looks for (recall), what is no longer true (forget).
 */
export function buildMemoryTools(ctx: { self: BotRow; memory: MemoryService }): ToolSet {
  const { self, memory } = ctx;
  return {
    remember: tool({
      description:
        "Retient une info sur l'utilisateur qui pourra servir à n'importe quel bot, plus tard : qui il est (nom, mail, date de naissance, adresse, métier), ce qu'il aime ou utilise (artistes, appli de musique, régime…), un événement daté (compétition, vol, rendez-vous, échéance : at), une habitude. Fais-le dès qu'il en parle, même au détour d'une conversation, sans le lui dire ni le lui demander. Une info qui change remplace l'ancienne (replaces : son id). Jamais de mot de passe, de code ni de clé : ceux-là vont au coffre.",
      inputSchema: z.object({
        fact: z
          .string()
          .trim()
          .min(1)
          .max(MEMORY_TEXT_MAX)
          .describe("L'info, en une phrase autonome (« Son mail perso est jo@exemple.fr »)"),
        kind: memoryKindSchema.describe(
          'profile : qui il est ; preference : ce qu’il aime ou utilise ; event : daté ; note : le reste',
        ),
        at: z
          .string()
          .optional()
          .describe(
            'Pour un événement : date et heure ISO 8601 avec fuseau (« 2026-11-14T09:00:00+01:00 »)',
          ),
        replaces: z.string().optional().describe("L'id du souvenir qu'elle remplace"),
      }),
      execute: async ({ fact, kind, at, replaces }) => {
        if (SECRET.test(fact)) {
          throw new Error(
            'Ça ressemble à un secret : range-le au coffre (vault_save_secret, ou vault_request pour le lui demander), pas dans la mémoire.',
          );
        }
        if (kind === 'event' && !at) throw new Error('Un événement a une date : donne at.');
        const when = at ? new Date(at) : null;
        if (when && Number.isNaN(when.getTime()))
          throw new Error(`« ${at} » n'est pas une date ISO.`);
        const { memory: kept, status } = await memory
          .remember(
            {
              kind,
              text: fact,
              ...(when ? { at: when.toISOString() } : {}),
              ...(replaces ? { replaces: await memory.resolve(replaces) } : {}),
            },
            self.id,
          )
          .catch(toolError);
        return status === 'known'
          ? `Déjà dans la mémoire [${kept.id.slice(0, 8)}].`
          : `Retenu [${kept.id.slice(0, 8)}] : tous les bots le savent désormais.`;
      },
    }),
    recall: tool({
      description:
        "Cherche dans la mémoire de l'utilisateur (ce que les bots ont retenu de lui), au-delà de ce que ton prompt en montre : par mots-clés (« anniversaire », « Spotify », « vol »).",
      inputSchema: z.object({ query: z.string().trim().min(2).max(200) }),
      execute: async ({ query }) => {
        const found = await memory.search(query);
        if (found.length === 0) return `Rien dans la mémoire sur « ${query} ».`;
        return found
          .map(
            (m) =>
              `- [${m.id.slice(0, 8)}] (${MEMORY_KIND_LABELS[m.kind]}${m.at ? `, ${m.at}` : ''}) ${m.text}`,
          )
          .join('\n');
      },
    }),
    forget: tool({
      description:
        "Oublie un souvenir devenu faux ou inutile (l'utilisateur l'a dit, ou un événement passé qui ne sert plus), par son id.",
      inputSchema: z.object({ id: z.string().trim().min(4) }),
      execute: async ({ id }) => {
        await memory.forget(await memory.resolve(id)).catch(toolError);
        return 'Oublié.';
      },
    }),
  };
}
