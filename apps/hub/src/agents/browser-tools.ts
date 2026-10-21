import { type ToolSet, tool } from 'ai';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { botFolder } from '../bots/service';
import type { AgentClient } from '../computers/agent-client';
import type { WorkspaceFiles } from '../workspaces/files';
import { type BrowserHub, formatSnapshot } from './browser';

export interface BrowserToolContext {
  botId: string;
  botName: string;
  computerId: string;
  workspaceId: string | null;
  files: WorkspaceFiles;
  browser: BrowserHub;
  /** Starts the bot's computer if needed. */
  computer(): Promise<AgentClient>;
  /** Screenshots (base64) shown to the model at its next step. */
  pendingImages: string[];
  /** Fills in `{{vault:…}}` placeholders in typed text. */
  expand(text: string): Promise<string>;
}

const intentSchema = z
  .string()
  .max(80)
  .optional()
  .describe("Ce que tu fais, en quelques mots, pour l'utilisateur (ex. « Accepte les cookies »)");

const refSchema = z.number().int().min(1).describe('Numéro de l’élément dans le dernier aperçu');

/** After an action: the page as it is now (pages update without a full load). */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

/**
 * Web tools: the bot drives its own Chrome window over DevTools, without the mouse, the keyboard
 * or the screen. Each action returns the page's text and its numbered elements.
 */
export function buildBrowserTools(ctx: BrowserToolContext): ToolSet {
  const tools: ToolSet = {};
  const page = async () => ctx.browser.page(ctx.botId, ctx.computerId, await ctx.computer());
  const describe = async (current: Page) => formatSnapshot(await ctx.browser.snapshot(current));
  const act = async (ref: number, action: (current: Page) => Promise<void>) => {
    const current = await page();
    try {
      await action(current);
    } catch (error) {
      throw new Error(
        `Élément ${ref} introuvable ou inutilisable (la page a peut-être changé) : reprends un aperçu avec browser_snapshot. ${(error as Error).message.split('\n')[0]}`,
      );
    }
    await settled(current);
    return describe(current);
  };

  tools.browser_open = tool({
    description:
      "Ouvre une adresse dans TA fenêtre de Chrome (rien qu'à toi, les autres bots ont la leur ; les connexions aux sites sont partagées). Renvoie le texte de la page et ses éléments numérotés. show: true l'affiche au premier plan sur l'écran du PC (pour que l'utilisateur la voie ou prenne la main).",
    inputSchema: z.object({ url: z.url(), show: z.boolean().default(false) }),
    execute: async ({ url, show }) => {
      const current = await page();
      await current.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settled(current);
      if (show) await current.bringToFront();
      return describe(current);
    },
  });

  tools.browser_snapshot = tool({
    description: 'Relit ta page : son texte et ses éléments numérotés.',
    inputSchema: z.object({}),
    execute: async () => describe(await page()),
  });

  tools.browser_click = tool({
    description: 'Clique sur un élément de ta page, par son numéro.',
    inputSchema: z.object({ intent: intentSchema, ref: refSchema }),
    execute: async ({ ref }) =>
      act(ref, (current) => ctx.browser.element(current, ref).click({ timeout: 10_000 })),
  });

  tools.browser_type = tool({
    description:
      "Remplit un champ de ta page (le texte remplace ce qu'il contenait). submit: true appuie ensuite sur Entrée. Pour un mot de passe ou un code du coffre, écris son placeholder {{vault:ref.password}} : la valeur est tapée sans passer par toi.",
    inputSchema: z.object({
      intent: intentSchema,
      ref: refSchema,
      text: z.string().max(10_000),
      submit: z.boolean().default(false),
    }),
    execute: async ({ ref, text, submit }) =>
      act(ref, async (current) => {
        const field = ctx.browser.element(current, ref);
        await field.fill(await ctx.expand(text), { timeout: 10_000 });
        if (submit) await field.press('Enter');
      }),
  });

  tools.browser_select = tool({
    description: "Choisit une option d'une liste déroulante de ta page.",
    inputSchema: z.object({
      intent: intentSchema,
      ref: refSchema,
      option: z.string().describe("Texte ou valeur de l'option"),
    }),
    execute: async ({ ref, option }) =>
      act(ref, async (current) => {
        const select = ctx.browser.element(current, ref);
        await select
          .selectOption({ label: option }, { timeout: 5_000 })
          .catch(() => select.selectOption(option, { timeout: 5_000 }));
      }),
  });

  tools.browser_press = tool({
    description: 'Appuie sur une touche dans ta page (ex. Enter, Escape, Tab, PageDown).',
    inputSchema: z.object({ key: z.string().min(1).max(40) }),
    execute: async ({ key }) => {
      const current = await page();
      await current.keyboard.press(key);
      await settled(current);
      return describe(current);
    },
  });

  tools.browser_scroll = tool({
    description: 'Fait défiler ta page (pour voir et numéroter la suite).',
    inputSchema: z.object({ direction: z.enum(['down', 'up']).default('down') }),
    execute: async ({ direction }) => {
      const current = await page();
      await current.mouse.wheel(0, direction === 'down' ? 700 : -700);
      await current.waitForTimeout(400);
      return describe(current);
    },
  });

  tools.browser_back = tool({
    description: 'Revient à la page précédente.',
    inputSchema: z.object({}),
    execute: async () => {
      const current = await page();
      await current.goBack({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await settled(current);
      return describe(current);
    },
  });

  tools.browser_screenshot = tool({
    description:
      "Capture ta page telle qu'elle s'affiche (sans toucher à l'écran du PC) : pour vérifier une mise en page, un graphique ou une image.",
    inputSchema: z.object({}),
    execute: async () => {
      const current = await page();
      const png = await current.screenshot({ type: 'png', timeout: 20_000 });
      let saved: string | null = null;
      if (ctx.workspaceId) {
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        const entry = await ctx.files.writeFile(
          ctx.workspaceId,
          `${botFolder(ctx.botName)}/captures/${name}`,
          png,
        );
        saved = entry.path;
      }
      ctx.pendingImages.push(png.toString('base64'));
      return { saved };
    },
    toModelOutput: () => ({
      type: 'text',
      value: "Capture de ta page prise : l'image est jointe au message suivant.",
    }),
  });

  return tools;
}
