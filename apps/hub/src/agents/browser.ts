/// <reference lib="dom" />
// DOM types for snapshotInPage, which runs in the bot's page.
import type { BotBrowser } from '@mowbot/contract';
import { type Browser, chromium, type Page } from 'playwright-core';
import type { AgentClient } from '../computers/agent-client';
import { chromeReadyScript, rememberTab } from './desktop';

/** What a bot sees of a page: its text and the elements it can act on, numbered. */
export interface Snapshot {
  title: string;
  url: string;
  text: string;
  elements: string[];
}

const MAX_TEXT = 6_000;
const MAX_ELEMENTS = 150;
const VIEW_REUSE_MS = 700;
const CLOSED: BotBrowser = { open: false, title: null, url: null, image: null };

/**
 * Numbers the visible interactive elements (`data-mowbot-ref`) and reads the page's text.
 * Runs in the page, so it must stay self-contained.
 */
function snapshotInPage(limits: { text: number; elements: number }): Snapshot {
  for (const el of document.querySelectorAll('[data-mowbot-ref]')) {
    el.removeAttribute('data-mowbot-ref');
  }
  const selector = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'textarea',
    'select',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=option]',
    '[role=switch]',
    '[contenteditable=""]',
    '[contenteditable=true]',
  ].join(',');
  const elements: string[] = [];
  let ref = 0;
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (elements.length >= limits.elements) break;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
    ref += 1;
    node.setAttribute('data-mowbot-ref', String(ref));
    const tag = node.tagName.toLowerCase();
    const input = node as HTMLInputElement;
    const kind =
      node.getAttribute('role') ??
      (tag === 'a'
        ? 'lien'
        : tag === 'button'
          ? 'bouton'
          : tag === 'select'
            ? 'liste'
            : tag === 'input' || tag === 'textarea'
              ? `champ ${input.type || 'texte'}`
              : tag);
    const name = (
      node.getAttribute('aria-label') ??
      (node.innerText || input.value || node.getAttribute('placeholder') || node.title || '')
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const state = input.checked ? ' (coché)' : '';
    const offscreen = box.bottom < 0 || box.top > window.innerHeight ? ' (hors écran)' : '';
    elements.push(`[${ref}] ${kind}${name ? ` « ${name} »` : ''}${state}${offscreen}`);
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, limits.text),
    elements,
  };
}

export function formatSnapshot(snapshot: Snapshot): string {
  return [
    `Page : ${snapshot.title || '(sans titre)'} — ${snapshot.url}`,
    '',
    'Texte (début) :',
    snapshot.text || '(vide)',
    '',
    'Éléments (clique ou tape avec leur numéro) :',
    ...(snapshot.elements.length ? snapshot.elements : ['(aucun)']),
  ].join('\n');
}

/**
 * Each bot's own Chrome window on its computer, driven over DevTools (through mow-agent): no
 * mouse, no keyboard, no need for the screen, so bots of a team PC browse at the same time.
 * They share Chrome's profile, hence its logins.
 */
export class BrowserHub {
  private readonly browsers = new Map<string, Promise<Browser>>();
  private readonly pages = new Map<string, { computerId: string; page: Page }>();
  private readonly views = new Map<string, { page: Page; at: number; view: Promise<BotBrowser> }>();

  private connect(computerId: string, agent: AgentClient): Promise<Browser> {
    const existing = this.browsers.get(computerId);
    if (existing) return existing;
    const { url, headers } = agent.cdpEndpoint();
    const connecting = agent
      .exec(chromeReadyScript(), { timeoutMs: 45_000 })
      .then((ready) => {
        if (ready.exitCode !== 0) throw new Error(ready.stderr.trim() || 'Chrome ne répond pas');
        return chromium.connectOverCDP(url, { headers, timeout: 30_000 });
      })
      .then((browser) => {
        browser.on('disconnected', () => this.forgetComputer(computerId));
        return browser;
      });
    connecting.catch(() => this.browsers.delete(computerId));
    this.browsers.set(computerId, connecting);
    return connecting;
  }

  private forgetComputer(computerId: string): void {
    this.browsers.delete(computerId);
    for (const [botId, entry] of this.pages) {
      if (entry.computerId === computerId) this.pages.delete(botId);
    }
  }

  /** The bot's current page, if it has one open. */
  current(botId: string): Page | null {
    const entry = this.pages.get(botId);
    return entry && !entry.page.isClosed() ? entry.page : null;
  }

  /** The bot's page, in a window of its own (opened on first use). */
  async page(botId: string, computerId: string, agent: AgentClient): Promise<Page> {
    const existing = this.current(botId);
    // A bot moved to another computer starts over there.
    if (existing && this.pages.get(botId)?.computerId === computerId) return existing;
    const browser = await this.connect(computerId, agent);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome has no browsing context');
    const session = await browser.newBrowserCDPSession();
    const opened = context.waitForEvent('page', { timeout: 15_000 });
    const { targetId } = (await session.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    })) as { targetId: string };
    await session.detach();
    const page = await opened;
    this.adopt(botId, computerId, page);
    await rememberTab(agent, botId, targetId).catch(() => undefined);
    return page;
  }

  /** A link opening a new tab: the bot follows it there. */
  private adopt(botId: string, computerId: string, page: Page): void {
    this.pages.set(botId, { computerId, page });
    page.on('popup', (popup) => this.adopt(botId, computerId, popup));
    page.on('close', () => {
      if (this.pages.get(botId)?.page === page) this.pages.delete(botId);
    });
  }

  /**
   * What the bot's page shows now, for the live view. Viewers polling at the same time share
   * one capture.
   */
  view(botId: string): Promise<BotBrowser> {
    const page = this.current(botId);
    if (!page) return Promise.resolve(CLOSED);
    const recent = this.views.get(botId);
    if (recent && recent.page === page && Date.now() - recent.at < VIEW_REUSE_MS) {
      return recent.view;
    }
    const view = Promise.all([
      page.screenshot({ type: 'jpeg', quality: 60, timeout: 10_000 }),
      page.title(),
    ]).then(
      ([jpeg, title]): BotBrowser => ({
        open: true,
        title,
        url: page.url(),
        image: jpeg.toString('base64'),
      }),
      () => CLOSED,
    );
    this.views.set(botId, { page, at: Date.now(), view });
    return view;
  }

  /** Puts the bot's window in front on the computer's screen (for the user to take over). */
  async front(botId: string): Promise<boolean> {
    const page = this.current(botId);
    if (!page) return false;
    await page.bringToFront();
    return true;
  }

  async snapshot(page: Page): Promise<Snapshot> {
    return page.evaluate(snapshotInPage, { text: MAX_TEXT, elements: MAX_ELEMENTS });
  }

  /** The element a snapshot numbered. */
  element(page: Page, ref: number) {
    return page.locator(`[data-mowbot-ref="${ref}"]`).first();
  }

  async close(): Promise<void> {
    const browsers = await Promise.allSettled(this.browsers.values());
    this.browsers.clear();
    this.pages.clear();
    this.views.clear();
    for (const result of browsers) {
      // Disconnects the hub only: Chrome and its pages stay.
      if (result.status === 'fulfilled') await result.value.close().catch(() => undefined);
    }
  }
}
