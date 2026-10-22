import type { Bot, WebSearchSettings } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { type FetchedPage, FetchRefused, isPrivateAddress, safeFetch } from '../src/web/safe-fetch';
import { duckduckgoTarget, pageText, parseDuckduckgo, WebService } from '../src/web/service';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scripted, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const DUCK = `<html><body>
<div class="result results_links result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Pub</a></div>
<div class="result results_links"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide&amp;rut=x">Le <b>guide</b> complet</a></h2>
<a class="result__snippet" href="#">Tout sur le <b>sujet</b>, pas à pas.</a></div>
<div class="result results_links"><a class="result__a" href="https://other.example/page">Autre page</a></div>
</body></html>`;

const ARTICLE = `<html><head><title>Titre de l'onglet</title></head><body>
<nav><a href="/">Accueil</a> · <a href="/blog">Blog</a></nav>
<article><h1>Comment bien démarrer</h1>
<p>Premier paragraphe assez long pour être gardé par Readability, avec un <a href="/doc">lien vers la doc</a> et du texte, encore du texte, toujours du texte pour faire un article.</p>
<p>Deuxième paragraphe, lui aussi assez long pour compter comme du contenu principal de la page, avec des détails utiles.</p>
<ul><li>Un point</li><li>Un autre point</li></ul>
<pre>npm install</pre></article>
<footer>© 2026</footer></body></html>`;

describe('the web parsers', () => {
  it('read DuckDuckGo results, ads left out', () => {
    expect(parseDuckduckgo(DUCK)).toEqual([
      {
        title: 'Le guide complet',
        url: 'https://example.org/guide',
        snippet: 'Tout sur le sujet, pas à pas.',
      },
      { title: 'Autre page', url: 'https://other.example/page', snippet: '' },
    ]);
    expect(duckduckgoTarget('//duckduckgo.com/y.js?ad=1')).toBeNull();
  });

  it("keep a page's main content, as light Markdown", () => {
    const { title, text } = pageText(ARTICLE, 'https://blog.example/post');
    expect(title).toBe("Titre de l'onglet");
    expect(text).toContain('# Comment bien démarrer');
    expect(text).toContain('[lien vers la doc](https://blog.example/doc)');
    expect(text).toContain('- Un point');
    expect(text).toContain('```\nnpm install\n```');
    expect(text).not.toContain('Accueil');
  });
});

describe('fetching for the bots', () => {
  it('knows the local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.189',
      '169.254.169.254',
      '::1',
      'fe80::1',
      'fd00::2',
      '::ffff:10.0.0.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('never reaches the local network, nor other protocols', async () => {
    await expect(safeFetch('http://127.0.0.1:8787/api/v1/health')).rejects.toBeInstanceOf(
      FetchRefused,
    );
    await expect(safeFetch('http://[::1]/')).rejects.toBeInstanceOf(FetchRefused);
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(FetchRefused);
    await expect(safeFetch('https://user:pw@example.org/')).rejects.toBeInstanceOf(FetchRefused);
    // A public-looking name that resolves inside: refused when connecting.
    const inside = safeFetch('http://rebind.example/', {
      resolve: ((_host: string, _options: unknown, callback: (e: null, a: unknown) => void) =>
        callback(null, [{ address: '192.168.1.10', family: 4 }])) as never,
    });
    await expect(inside).rejects.toBeInstanceOf(FetchRefused);
  });
});

/** A web of a few pages, by URL prefix. */
function fakeWeb(pages: Record<string, Partial<FetchedPage>>) {
  const calls: { url: string; headers?: Record<string, string>; body?: string }[] = [];
  const fetchPage = async (
    url: string,
    options?: { headers?: Record<string, string>; body?: string },
  ): Promise<FetchedPage> => {
    calls.push({ url, headers: options?.headers, body: options?.body });
    const key = Object.keys(pages).find((prefix) => url.startsWith(prefix));
    if (!key) return { url, status: 404, contentType: 'text/plain', body: 'not found', cut: false };
    return { url, status: 200, contentType: 'text/html', body: '', cut: false, ...pages[key] };
  };
  return { fetchPage, calls };
}

describe('web search', () => {
  it('searches DuckDuckGo by default, or Brave with its key (never shown again)', async () => {
    const web = fakeWeb({
      'https://html.duckduckgo.com/html/': { body: DUCK },
      'https://api.search.brave.com/': {
        contentType: 'application/json',
        body: JSON.stringify({
          web: {
            results: [
              {
                title: 'Brave <strong>hit</strong>',
                url: 'https://b.example',
                description: 'From <strong>Brave</strong>',
              },
            ],
          },
        }),
      },
    });
    t = await createTestApp({}, undefined, undefined, { webFetch: web.fetchPage });
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const call = async <T>(method: 'GET' | 'PUT', url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers: auth, payload: payload as object });
      return { status: res.statusCode, body: res.json() as T };
    };

    expect((await call<WebSearchSettings>('GET', '/api/v1/settings/web-search')).body).toEqual({
      provider: 'duckduckgo',
      hasKey: false,
    });
    expect(await services.web.search('guide')).toHaveLength(2);
    expect(web.calls[0]?.body).toContain('q=guide');
    // Taken for a robot: the bot is told what to do instead.
    const blocked = new WebService(services.db, services.config.masterKey, async (url) => ({
      url,
      status: 202,
      contentType: 'text/html',
      body: '<html>anomaly</html>',
      cut: false,
    }));
    await expect(blocked.search('guide')).rejects.toThrow(/navigateur de ton PC/);

    expect((await call('PUT', '/api/v1/settings/web-search', { provider: 'brave' })).status).toBe(
      400,
    );
    const saved = await call<WebSearchSettings>('PUT', '/api/v1/settings/web-search', {
      provider: 'brave',
      apiKey: 'brave-key-123456',
    });
    expect(saved.body).toEqual({ provider: 'brave', hasKey: true });
    expect(JSON.stringify(saved.body)).not.toContain('brave-key');
    expect(await services.web.search('hit', 3)).toEqual([
      { title: 'Brave hit', url: 'https://b.example', snippet: 'From Brave' },
    ]);
    expect(web.calls.at(-1)?.headers?.['x-subscription-token']).toBe('brave-key-123456');
    expect(web.calls.at(-1)?.url).toContain('count=3');
  });

  it('gives every bot web_search and web_read, even without a computer', async () => {
    const web = fakeWeb({
      'https://html.duckduckgo.com/html/': { body: DUCK },
      'https://example.org/guide': { body: ARTICLE },
    });
    const model = scripted([
      toolTurn('web_search', { query: 'guide complet' }),
      toolTurn('web_read', { url: 'https://example.org/guide' }, 'call-2'),
      textTurn('Voici le guide.'),
    ]);
    t = await createTestApp({}, undefined, () => model, { webFetch: web.fetchPage });
    const { app, services } = t;
    const auth = bearer((await setupOwner(app)).accessToken);
    const chef = (await app.inject({ method: 'GET', url: '/api/v1/bots', headers: auth })).json()
      .items[0] as Bot;
    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: auth,
      payload: { text: 'Trouve le guide' },
    });
    await services.runtime.settle();

    expect(promptOf(model, 0)).toContain('web_search, web_read');
    expect(promptOf(model, 1)).toContain('1. Le guide complet');
    expect(promptOf(model, 1)).toContain('https://example.org/guide');
    expect(promptOf(model, 2)).toContain('# Comment bien démarrer');
    // The search and the page came from the hub: no computer was started.
    expect(t.runtime.machines.size).toBe(0);
  });
});
