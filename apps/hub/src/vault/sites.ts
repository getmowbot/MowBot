import { createHash } from 'node:crypto';
import { getDomain, getHostname } from 'tldts';

/** A cookie as Chrome reports it over DevTools (Playwright's shape). */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}

/** A browser session as the vault stores it. */
export interface SessionPayload {
  cookies: Cookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

/**
 * The site an address, a host or a cookie domain belongs to: its registrable domain
 * (`accounts.google.com` → `google.com`, `www.bbc.co.uk` → `bbc.co.uk`), or the host itself for
 * IPs and single-label names.
 */
export function siteOf(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/^\.+/, '');
  if (!trimmed) return null;
  const host = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
    ? getHostname(trimmed)
    : getHostname(`https://${trimmed}`);
  if (!host) return null;
  return getDomain(host, { allowPrivateDomains: false }) ?? host;
}

export function cookieSite(cookie: Pick<Cookie, 'domain'>): string | null {
  return siteOf(cookie.domain);
}

/** The cookies of these sites. */
export function cookiesOf(cookies: Cookie[], sites: string[]): Cookie[] {
  const wanted = new Set(sites);
  return cookies.filter((c) => {
    const site = cookieSite(c);
    return site !== null && wanted.has(site);
  });
}

/** Sites with cookies, most cookies first. */
export function sitesWithCookies(cookies: Cookie[]): { site: string; cookies: number }[] {
  const counts = new Map<string, number>();
  for (const cookie of cookies) {
    const site = cookieSite(cookie);
    if (site) counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts]
    .map(([site, count]) => ({ site, cookies: count }))
    .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

/** Infrastructure cookies that rotate on every visit and say nothing about a login. */
const NOISE = /^(__cf|_cf|cf_|__cfruid|awsalb|awselb|__ddg|_dd_s|datadome|ak_bmsc|bm_|_abck)/i;

/**
 * What the server set on each site, hashed: logins leave HttpOnly cookies, analytics scripts
 * do not.
 */
export function fingerprint(cookies: Cookie[]): Map<string, Map<string, string>> {
  const bySite = new Map<string, Map<string, string>>();
  for (const cookie of cookies) {
    if (!cookie.httpOnly || NOISE.test(cookie.name)) continue;
    const site = cookieSite(cookie);
    if (!site) continue;
    const entries = bySite.get(site) ?? new Map<string, string>();
    entries.set(
      `${cookie.domain}|${cookie.path}|${cookie.name}`,
      createHash('sha256').update(cookie.value).digest('base64url'),
    );
    bySite.set(site, entries);
  }
  return bySite;
}

/** Sites whose server-set cookies appeared or changed between two fingerprints. */
export function changedSites(
  before: Map<string, Map<string, string>>,
  after: Map<string, Map<string, string>>,
): string[] {
  const changed: string[] = [];
  for (const [site, entries] of after) {
    const previous = before.get(site);
    for (const [key, hash] of entries) {
      if (previous?.get(key) !== hash) {
        changed.push(site);
        break;
      }
    }
  }
  return changed.sort();
}

/** `google.com` → `Google`, a default name for a session saved without one. */
export function serviceName(site: string): string {
  const label = site.split('.')[0] ?? site;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
