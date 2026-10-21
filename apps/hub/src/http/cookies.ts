/**
 * Cookies are scoped by host, not by port: the bots' previews, served on other ports of the
 * hub's own address, share the hub's cookie jar. These helpers keep the two apart.
 */

/** `name=value` → `name`; a pair without `=` is all name (that is how it can be misread). */
function nameOf(pair: string): string {
  const eq = pair.indexOf('=');
  return (eq < 0 ? pair : pair.slice(0, eq)).trim();
}

/** The hub's cookies (refresh token, previews' access): `mowbot_…`, with or without a prefix. */
export function isHubCookie(name: string): boolean {
  return /^(__(host|secure)-)?mowbot_/i.test(name.trim());
}

/**
 * Every value a cookie has in a `Cookie` header, most specific path first. A page on another
 * port can add a cookie of the same name with a longer path: the real one is still among them.
 */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }
  return values;
}

/** A `Cookie` header without the hub's cookies (null when nothing is left). */
export function withoutHubCookies(header: string | undefined): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !isHubCookie(nameOf(pair)));
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * What a preview's `Set-Cookie` may do: never set one of the hub's cookies, and only for its
 * own host (a `Domain` would reach the parent domain and its other sites). Null: dropped.
 */
export function safeSetCookie(value: string): string | null {
  const [pair = '', ...attributes] = value.split(';');
  if (!pair.trim()) return null;
  // A nameless cookie (`=mowbot_x=1`) is sent back as its bare value: judge that.
  const name = nameOf(pair) || nameOf(pair.slice(pair.indexOf('=') + 1));
  if (isHubCookie(name)) return null;
  return [pair, ...attributes.filter((attribute) => !/^\s*domain\s*=/i.test(attribute))].join(';');
}
