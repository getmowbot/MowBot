import type { MessagePart } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { asc } from 'drizzle-orm';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { Db } from '../db/client';
import { computers } from '../db/schema';
import type { NotificationService } from '../proactivity/notifications';
import { labelOf, type VaultService } from '../vault/service';

export interface VaultToolContext {
  self: BotRow;
  vault: VaultService;
  db: Db;
  /** Starts the bot's computer if needed (null: the bot has none). */
  computer: (() => Promise<AgentClient>) | null;
  /** Puts a part (the vault request form) in the bot's current answer. */
  showPart?: (part: MessagePart) => Promise<void>;
  notifications?: NotificationService;
}

/** The tool that asks the user for a login in the conversation (drawn as a form). */
export const VAULT_REQUEST = 'vault_request';

const refSchema = z.string().min(4).max(36).describe('Référence de l’entrée (vault_list)');

const ago = (date: Date | null) => {
  if (!date) return null;
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 60) return `il y a ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`;
};

/**
 * The vault: sessions to load into the bot's Chrome, logins and secrets to use through
 * placeholders. Values never reach the bot.
 */
export function buildVaultTools(ctx: VaultToolContext): ToolSet {
  const { self, vault, db } = ctx;
  const tools: ToolSet = {};

  tools.vault_list = tool({
    description:
      "Liste le coffre : sessions de sites (connexions déjà faites sur un PC), identifiants et secrets, avec leur référence. Les valeurs n'apparaissent jamais.",
    inputSchema: z.object({
      query: z.string().max(100).optional().describe('Filtre (service, compte, site)'),
    }),
    execute: async ({ query }) => {
      const [items, pcs] = await Promise.all([
        vault.list(),
        db
          .select({ id: computers.id, name: computers.name })
          .from(computers)
          .orderBy(asc(computers.createdAt)),
      ]);
      const needle = query?.trim().toLowerCase();
      const shown = needle
        ? items.filter((item) =>
            [item.service, item.account ?? '', ...item.sites].some((text) =>
              text.toLowerCase().includes(needle),
            ),
          )
        : items;
      if (shown.length === 0) {
        return needle ? `Rien dans le coffre pour « ${query} ».` : 'Le coffre est vide.';
      }
      return shown
        .map((item) => {
          const where = pcs.find((pc) => pc.id === item.computerId)?.name;
          const how =
            item.kind === 'session'
              ? item.computerId === self.computerId
                ? 'session déjà dans le Chrome de ton PC'
                : `session de « ${where ?? 'un PC supprimé'} », à charger avec vault_use_session`
              : item.kind === 'login'
                ? `identifiant — ${item.fields.map((f) => `{{vault:${item.ref}.${f}}}`).join(' ')}`
                : `secret — {{vault:${item.ref}.value}}`;
          const asks =
            item.policy === 'ask' &&
            !item.grantedBotIds.includes(self.id) &&
            item.computerId !== self.computerId
              ? " (sur accord de l'utilisateur)"
              : '';
          const captured =
            item.kind === 'session' && item.capturedAt
              ? `, capturée ${ago(new Date(item.capturedAt))}`
              : '';
          const sites = item.sites.length ? ` — ${item.sites.join(', ')}` : '';
          return `- [${item.ref}] ${labelOf(item)}${sites} : ${how}${captured}${asks}`;
        })
        .join('\n');
    },
  });

  const showPart = ctx.showPart;
  if (showPart) {
    tools[VAULT_REQUEST] = tool({
      description:
        "Demande à l'utilisateur un identifiant (nom d'utilisateur, mot de passe, graine 2FA) ou un secret (clé d'API…) qui manque au coffre : un formulaire aux champs masqués s'affiche dans la conversation et ce qu'il tape va directement dans le coffre, sans passer par toi ni par le chat. Tu reçois ensuite un message avec la référence à utiliser. Ne demande jamais un mot de passe en clair dans le chat. ref : pour remplacer les valeurs d'une entrée existante (mot de passe changé).",
      inputSchema: z.object({
        kind: z.enum(['login', 'secret']),
        service: z.string().trim().min(1).max(100).describe('Ex. « BadNet », « OpenWeather »'),
        account: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe('Le compte, ex. une adresse e-mail'),
        sites: z.array(z.string().max(253)).max(10).optional(),
        fields: z
          .array(z.enum(['username', 'password', 'totp', 'value']))
          .min(1)
          .max(3)
          .optional()
          .describe(
            'Champs à remplir (par défaut : username et password, ou value pour un secret)',
          ),
        reason: z.string().max(200).optional().describe('Pourquoi tu en as besoin, en une phrase'),
        ref: refSchema.optional(),
      }),
      execute: async ({ kind, service, account, sites, fields, reason, ref }) => {
        const existing = ref ? await vault.byRef(ref) : null;
        const allowed = kind === 'secret' ? ['value'] : ['username', 'password', 'totp'];
        const wanted = (
          fields ?? (kind === 'secret' ? ['value'] : ['username', 'password'])
        ).filter((field) => allowed.includes(field));
        if (wanted.length === 0) {
          throw new Error(
            kind === 'secret'
              ? 'Un secret se demande avec le champ value.'
              : 'Champs : username, password, totp.',
          );
        }
        await showPart({
          type: 'vault_request',
          kind,
          service: existing?.service ?? service,
          account: existing ? existing.account : (account ?? null),
          sites: existing?.sites ?? sites ?? [],
          fields: wanted,
          reason: reason ?? null,
          itemId: existing?.id ?? null,
          status: 'pending',
        });
        await ctx.notifications?.create({
          botId: self.id,
          priority: 'normal',
          title: `${self.name} a besoin d'un identifiant`,
          push: 'needs_you',
          body: `${service}${account ? ` (${account})` : ''} : à ranger dans le coffre depuis la conversation.`,
        });
        return "Formulaire affiché dans la conversation : l'utilisateur le remplit quand il peut. Tu recevras un message avec la référence (ou son refus) ; termine ton tour en attendant.";
      },
    });
  }

  tools.vault_save_secret = tool({
    description:
      "Range dans le coffre un identifiant (username, password, graine 2FA) ou un secret (clé d'API, jeton) pour ne plus le garder en clair. Renvoie les placeholders à utiliser ensuite.",
    inputSchema: z.object({
      kind: z.enum(['login', 'secret']),
      service: z.string().trim().min(1).max(100).describe('Ex. « OpenWeather », « BadNet »'),
      account: z.string().trim().max(200).optional().describe('Le compte, ex. une adresse e-mail'),
      sites: z.array(z.string().max(253)).max(10).optional().describe('Sites concernés'),
      username: z.string().max(500).optional(),
      password: z.string().max(10_000).optional(),
      totp: z.string().max(500).optional().describe('Graine 2FA (base32 ou lien otpauth://)'),
      value: z.string().max(10_000).optional().describe('Le secret (kind secret)'),
    }),
    execute: async (input) => {
      if (input.kind === 'secret' && !input.value) throw new Error('Un secret demande value.');
      const item =
        input.kind === 'secret'
          ? await vault.create(
              {
                kind: 'secret',
                service: input.service,
                account: input.account,
                sites: input.sites,
                value: input.value ?? '',
              },
              { botId: self.id },
            )
          : await vault.create(
              {
                kind: 'login',
                service: input.service,
                account: input.account,
                sites: input.sites,
                username: input.username,
                password: input.password,
                totp: input.totp,
              },
              { botId: self.id },
            );
      return `Rangé dans le coffre [${item.ref}]. Utilise ${item.fields
        .map((f) => `{{vault:${item.ref}.${f}}}`)
        .join(
          ', ',
        )} dans bash, browser_type ou computer (type) ; ne réécris plus la valeur en clair.`;
    },
  });

  const computer = ctx.computer;
  if (!computer || !self.computerId) return tools;
  const computerId = self.computerId;

  tools.vault_use_session = tool({
    description:
      "Charge dans le Chrome de ton PC une session du coffre (cookies d'un site où l'utilisateur ou un bot s'est connecté sur un autre PC) : tu es alors connecté au site sans mot de passe.",
    inputSchema: z.object({ ref: refSchema }),
    execute: async ({ ref }) => {
      const row = await vault.byRef(ref);
      return vault.useSession(row, self, await computer());
    },
  });

  tools.vault_save_session = tool({
    description:
      "Enregistre dans le coffre ta connexion à un site (ses cookies dans le Chrome de ton PC), pour les bots des autres PC. À faire après t'être connecté à un compte, ou pour rafraîchir une session.",
    inputSchema: z.object({
      site: z
        .string()
        .min(1)
        .max(2_000)
        .describe('Le site ou une de ses adresses, ex. accounts.google.com'),
      service: z.string().trim().min(1).max(100).optional().describe('Ex. « Google »'),
      account: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe('Le compte connecté, ex. une adresse e-mail'),
    }),
    execute: async ({ site, service, account }) => {
      const item = await vault.capture({
        computerId,
        site,
        service,
        account,
        botId: self.id,
        agent: await computer(),
      });
      return `Session ${labelOf(item)} enregistrée [${item.ref}] (${item.session?.cookies ?? 0} cookies) : les bots des autres PC peuvent la charger avec vault_use_session.`;
    },
  });

  return tools;
}
