import type { WebSearchProvider, WebSearchSettings, WebSearchUpdate } from '@mowbot/contract';
import { Readability } from '@mozilla/readability';
import { eq } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import { open, seal } from '../crypto/secretbox';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import { HttpProblem } from '../http/problems';
import { type FetchedPage, FetchRefused, type SafeFetchOptions, safeFetch } from './safe-fetch';

const SETTINGS_KEY = 'web-search';
const KEY_PURPOSE = 'web-search-key';

/** How much of a page a bot reads at once; the rest comes with `offset`. */
export const PAGE_CHARS = 12_000;
/** Results a search returns by default, and at most. */
const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 10;

interface Stored {
  provider: WebSearchProvider;
  keySealed: string | null;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ReadPage {
  url: string;
  title: string;
  text: string;
  /** Where the next part starts (`offset`); null: this was the end. */
  next: number | null;
  total: number;
}

type Fetcher = (url: string, options?: SafeFetchOptions) => Promise<FetchedPage>;

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A DuckDuckGo result link (`//duckduckgo.com/l/?uddg=…`) to the page it leads to. */
export function duckduckgoTarget(href: string): string | null {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return target;
    return /^https?:$/.test(url.protocol) && !url.hostname.endsWith('duckduckgo.com')
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The results of DuckDuckGo's HTML page (its ads left out). */
export function parseDuckduckgo(html: string): SearchResult[] {
  const { document } = parseHTML(html);
  const results: SearchResult[] = [];
  for (const block of document.querySelectorAll('.result')) {
    if (block.classList.contains('result--ad')) continue;
    const link = block.querySelector('a.result__a');
    const url = link ? duckduckgoTarget(link.getAttribute('href') ?? '') : null;
    if (!link || !url) continue;
    results.push({
      title: collapse(link.textContent ?? ''),
      url,
      snippet: collapse(block.querySelector('.result__snippet')?.textContent ?? ''),
    });
  }
  return results;
}

/** A page's main content as plain text with light Markdown (headings, lists, links). */
export function pageText(html: string, base: string): { title: string; text: string } {
  const { document } = parseHTML(html);
  const title = collapse(document.querySelector('title')?.textContent ?? '');
  // Readability changes the document: it works on its own copy.
  const article = new Readability(parseHTML(html).document as unknown as Document).parse();
  const root = article?.content ? parseHTML(`<main>${article.content}</main>`).document : document;
  const main = root.querySelector('main') ?? root.querySelector('body') ?? root;
  for (const junk of main.querySelectorAll('script, style, noscript, svg, iframe, form, nav')) {
    junk.remove();
  }
  const lines: string[] = [];
  const walk = (node: Node, prefix = '') => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) continue;
      const el = child as Element;
      const tag = el.tagName?.toLowerCase();
      if (!tag) continue;
      const text = () => inline(el, base);
      if (/^h[1-6]$/.test(tag)) {
        const line = text();
        if (line) lines.push('', `${'#'.repeat(Number(tag[1]))} ${line}`);
      } else if (tag === 'p' || tag === 'blockquote' || tag === 'figcaption' || tag === 'dd') {
        const line = text();
        if (line) lines.push('', `${tag === 'blockquote' ? '> ' : ''}${line}`);
      } else if (tag === 'li') {
        const line = text();
        if (line) lines.push(`${prefix}- ${line}`);
      } else if (tag === 'ul' || tag === 'ol') {
        lines.push('');
        walk(el, prefix);
      } else if (tag === 'pre') {
        lines.push('', '```', (el.textContent ?? '').trimEnd(), '```');
      } else if (tag === 'tr') {
        const cells = [...el.querySelectorAll('th, td')].map((cell) =>
          collapse(cell.textContent ?? ''),
        );
        if (cells.some(Boolean)) lines.push(`| ${cells.join(' | ')} |`);
      } else if (tag === 'img') {
        const alt = collapse(el.getAttribute('alt') ?? '');
        if (alt) lines.push(`[image : ${alt}]`);
      } else {
        walk(el, prefix);
      }
    }
  };
  walk(main);
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: collapse(article?.title ?? '') || title,
    text: text || collapse(main.textContent ?? ''),
  };
}

/** An element's text, its links as Markdown links (absolute ones only). */
function inline(el: Element, base: string): string {
  let out = '';
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      out += child.textContent ?? '';
      continue;
    }
    const sub = child as Element;
    const tag = sub.tagName?.toLowerCase();
    if (tag === 'a') {
      const label = collapse(sub.textContent ?? '');
      const href = sub.getAttribute('href') ?? '';
      let url = '';
      try {
        url = new URL(href, base).toString();
      } catch {
        url = '';
      }
      out += label && /^https?:/.test(url) ? `[${label}](${url})` : label;
    } else if (tag === 'br') {
      out += '\n';
    } else if (tag === 'code') {
      out += `\`${collapse(sub.textContent ?? '')}\``;
    } else {
      out += inline(sub, base);
    }
  }
  return collapse(out);
}

/**
 * The bots' web from the hub, without their computer: searches (DuckDuckGo by default, or Brave
 * Search, Tavily with a key) and public pages read as text.
 */
export class WebService {
  private cache: Stored | null = null;

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    private readonly fetchPage: Fetcher = safeFetch,
  ) {}

  async settings(): Promise<WebSearchSettings> {
    const stored = await this.stored();
    return { provider: stored.provider, hasKey: Boolean(stored.keySealed) };
  }

  async configure(input: WebSearchUpdate): Promise<WebSearchSettings> {
    const current = await this.stored();
    const keySealed =
      input.apiKey === undefined
        ? input.provider === current.provider
          ? current.keySealed
          : null
        : input.apiKey === null
          ? null
          : seal(this.masterKey, KEY_PURPOSE, input.apiKey);
    if (input.provider !== 'duckduckgo' && !keySealed) {
      throw new HttpProblem(400, 'api_key_required', `${input.provider} needs an API key`);
    }
    const value: Stored = { provider: input.provider, keySealed };
    await this.db
      .insert(settings)
      .values({ key: SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
    this.cache = value;
    return this.settings();
  }

  async search(query: string, count = DEFAULT_RESULTS): Promise<SearchResult[]> {
    const wanted = Math.min(Math.max(1, count), MAX_RESULTS);
    const stored = await this.stored();
    const key = stored.keySealed ? open(this.masterKey, KEY_PURPOSE, stored.keySealed) : null;
    if (stored.provider === 'brave' && key) {
      const page = await this.fetchPage(
        `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(wanted) })}`,
        { headers: { accept: 'application/json', 'x-subscription-token': key } },
      );
      this.check(page, 'Brave Search');
      const data = JSON.parse(page.body) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      return (data.web?.results ?? []).slice(0, wanted).map((r) => ({
        title: collapse(stripTags(r.title ?? '')),
        url: r.url ?? '',
        snippet: collapse(stripTags(r.description ?? '')),
      }));
    }
    if (stored.provider === 'tavily' && key) {
      const page = await this.fetchPage('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: wanted }),
      });
      this.check(page, 'Tavily');
      const data = JSON.parse(page.body) as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      return (data.results ?? []).slice(0, wanted).map((r) => ({
        title: collapse(r.title ?? ''),
        url: r.url ?? '',
        snippet: collapse(r.content ?? '').slice(0, 400),
      }));
    }
    const page = await this.fetchPage('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: query, kl: 'fr-fr' }).toString(),
    });
    this.check(page, 'DuckDuckGo');
    const results = parseDuckduckgo(page.body);
    // 202, or its challenge page: it takes the hub for a robot (it often does).
    if (
      results.length === 0 &&
      (page.status === 202 || /anomaly|captcha|challenge/i.test(page.body))
    ) {
      throw new Error(
        "DuckDuckGo refuse les recherches du hub pour l'instant (il le prend pour un robot). Cherche avec le navigateur de ton PC (browser_open sur un moteur de recherche). Pour des recherches fiables, l'utilisateur peut brancher Brave Search ou Tavily (une clé gratuite) dans Outils → Recherche web : dis-le-lui une fois.",
      );
    }
    return results.slice(0, wanted);
  }

  /** A public page as text, `PAGE_CHARS` at a time from `offset`. */
  async read(url: string, offset = 0): Promise<ReadPage> {
    const page = await this.fetchPage(url);
    if (page.status >= 400) throw new Error(`La page répond ${page.status}.`);
    const type = page.contentType.toLowerCase();
    if (type.includes('pdf') || /^(image|audio|video)\//.test(type)) {
      throw new Error(
        'Ce lien est un fichier (PDF, image…), pas une page : télécharge-le sur ton PC pour le lire.',
      );
    }
    const html = type.includes('html') || /^\s*</.test(page.body);
    const { title, text } = html
      ? pageText(page.body, page.url)
      : { title: '', text: page.body.trim() };
    const start = Math.max(0, Math.min(offset, text.length));
    const end = Math.min(text.length, start + PAGE_CHARS);
    return {
      url: page.url,
      title,
      text:
        text.slice(start, end) +
        (page.cut && end === text.length ? '\n[page coupée : trop longue]' : ''),
      next: end < text.length ? end : null,
      total: text.length,
    };
  }

  private check(page: FetchedPage, service: string): void {
    if (page.status === 401 || page.status === 403) {
      throw new Error(
        `${service} refuse la clé de recherche : l'utilisateur doit la vérifier dans Outils.`,
      );
    }
    if (page.status === 429)
      throw new Error(`${service} : trop de recherches pour l'instant, réessaie plus tard.`);
    if (page.status >= 400) throw new Error(`${service} répond ${page.status}.`);
  }

  private async stored(): Promise<Stored> {
    if (this.cache) return this.cache;
    const [row] = await this.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY));
    this.cache = {
      provider: 'duckduckgo',
      keySealed: null,
      ...((row?.value ?? {}) as Partial<Stored>),
    };
    return this.cache;
  }
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, '');

export { FetchRefused };
