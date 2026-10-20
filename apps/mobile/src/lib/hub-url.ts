/** The owner's hub on the LAN during development (plain HTTP on 0.0.0.0:8787). */
export const DEFAULT_HUB_URL = 'http://192.168.1.189:8787';

const HUB_URL = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i;

/** `192.168.1.10:8787/` → `http://192.168.1.10:8787`; null when it cannot be a hub URL. */
export function normalizeHubUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  return HUB_URL.test(url) ? url : null;
}

/** `http://host:8787` → `ws://host:8787/api/v1/events?ticket=…` */
export function eventsSocketUrl(hubUrl: string, ticket: string): string {
  return `${hubUrl.replace(/^http/i, 'ws')}/api/v1/events?ticket=${encodeURIComponent(ticket)}`;
}

/** Hub problem `type` (`urn:mowbot:problem:invalid_credentials`) → `invalid_credentials`. */
export function problemCode(error: unknown): string | null {
  const type = (error as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type.replace('urn:mowbot:problem:', '') : null;
}
