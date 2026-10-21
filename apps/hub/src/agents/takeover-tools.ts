import type { MessagePart } from '@mowbot/contract';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { ComputerService } from '../computers/service';
import type { Db } from '../db/client';
import { hubTexts } from '../i18n';
import type { NotificationService } from '../proactivity/notifications';
import type { BrowserHub } from './browser';

export interface TakeoverToolContext {
  self: BotRow;
  computerId: string;
  computers: ComputerService;
  browser: BrowserHub;
  /** Starts the bot's computer if needed. */
  computer(): Promise<AgentClient>;
  /** Puts a part (the takeover card) in the bot's current answer. */
  showPart(part: MessagePart): Promise<void>;
  notifications?: NotificationService;
  db: Db;
}

/** The tool that asks the user to take control of the bot's computer (drawn as a card). */
export const REQUEST_TAKEOVER = 'request_takeover';

/**
 * What the bot cannot do itself on its computer (a sign-in, a 2FA code, a captcha): a card in
 * the conversation lets the user take control, and handing it back wakes the bot up.
 */
export function buildTakeoverTools(ctx: TakeoverToolContext): ToolSet {
  const { self, computerId } = ctx;
  return {
    [REQUEST_TAKEOVER]: tool({
      description:
        "Demande à l'utilisateur de prendre la main sur ton PC, pour ce que tu ne peux pas faire toi-même : se connecter à un compte absent du coffre, un code 2FA, un captcha, une validation sur son téléphone. Une carte s'affiche dans la conversation avec un bouton pour prendre le contrôle de l'écran. url : la page à afficher au premier plan pour lui (ta fenêtre de Chrome). Tu recevras un message quand il te rendra la main ; termine ton tour en attendant.",
      inputSchema: z.object({
        reason: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            'Ce que l’utilisateur doit faire, en une phrase (ex. « Connecte-toi à BadNet »)',
          ),
        url: z.url().optional().describe('La page à afficher sur l’écran du PC'),
      }),
      execute: async ({ reason, url }) => {
        const agent = await ctx.computer();
        if (url) {
          const page = await ctx.browser.page(self.id, computerId, agent);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await page.bringToFront();
        }
        const { control } = await ctx.computers.get(computerId);
        await ctx.showPart({
          type: 'takeover_request',
          computerId,
          reason,
          url: url ?? null,
          status: control ? 'taken' : 'pending',
        });
        if (control) {
          return "L'utilisateur a déjà la main sur ton PC : la carte le lui rappelle. Tu recevras un message quand il te la rendra ; termine ton tour en attendant.";
        }
        const texts = await hubTexts(ctx.db);
        await ctx.notifications?.create({
          botId: self.id,
          priority: 'normal',
          title: texts.needsTakeover(self.name),
          push: 'needs_you',
          body: reason,
        });
        return "Carte affichée dans la conversation : l'utilisateur prend la main quand il peut. Tu recevras un message quand il te la rendra ; termine ton tour en attendant.";
      },
    }),
  };
}
