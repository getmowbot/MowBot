import { describe, expect, it } from 'vitest';
import { resolveLanguage } from '../i18n/catalog';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import { bot, message, tool, translator } from '../test/fixtures';
import { moodOf, statusLabel } from './bot-mood';
import { eventsSocketUrl, normalizeHubUrl, problemCode } from './hub-url';
import { timeAgo } from './time';

function keysOf(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'string' ? [`${prefix}${key}`] : keysOf(child, `${prefix}${key}.`),
  );
}

describe('i18n', () => {
  it('has the same keys in every language', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(fr).sort());
  });

  it('follows the phone, falling back to French', () => {
    expect(resolveLanguage('system', 'en')).toBe('en');
    expect(resolveLanguage('system', 'en-GB')).toBe('en');
    expect(resolveLanguage('system', 'de')).toBe('fr');
    expect(resolveLanguage('system', null)).toBe('fr');
    expect(resolveLanguage('fr', 'en')).toBe('fr');
  });
});

describe('hub URL', () => {
  it('normalizes what people type', () => {
    expect(normalizeHubUrl(' 192.168.1.189:8787/ ')).toBe('http://192.168.1.189:8787');
    expect(normalizeHubUrl('https://mowbot.example.com')).toBe('https://mowbot.example.com');
    expect(normalizeHubUrl('ftp://x')).toBeNull();
    expect(normalizeHubUrl('')).toBeNull();
    expect(normalizeHubUrl('http://a b')).toBeNull();
  });

  it('derives the event socket URL', () => {
    expect(eventsSocketUrl('http://10.0.0.2:8787', 'a+b')).toBe(
      'ws://10.0.0.2:8787/api/v1/events?ticket=a%2Bb',
    );
    expect(eventsSocketUrl('https://hub.dev', 't')).toBe('wss://hub.dev/api/v1/events?ticket=t');
  });

  it('reads problem codes', () => {
    expect(problemCode({ type: 'urn:mowbot:problem:invalid_credentials' })).toBe(
      'invalid_credentials',
    );
    expect(problemCode(undefined)).toBeNull();
  });
});

describe('bot status', () => {
  it('tells thinking from working with the live answer', () => {
    const working = bot({ status: 'working' });
    expect(moodOf(working)).toBe('thinking');
    const live = message({ status: 'streaming', parts: [tool('bash', {}, 'running')] });
    expect(moodOf(working, live)).toBe('working');
    expect(moodOf(bot({ status: 'paused' }))).toBe('sleeping');
  });

  it('says which bot a bot waits for', async () => {
    expect(
      statusLabel(
        bot({ status: 'waiting_bot', statusDetail: 'Iris' }),
        'waiting',
        await translator('en'),
      ),
    ).toBe('waiting for Iris');
    const waiting = bot({ status: 'waiting_bot', statusDetail: 'Attend Nova' });
    expect(statusLabel(waiting, 'waiting', await translator('fr'))).toBe('attend Nova');
    expect(statusLabel(waiting, 'waiting', await translator('en'))).toBe('waiting for Nova');
    expect(statusLabel(bot({ status: 'working' }), 'working', await translator('en'))).toBe(
      'working on its PC…',
    );
  });

  it('formats relative times from the catalogs', async () => {
    const now = Date.UTC(2026, 9, 20, 12, 0, 0);
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
    const t = await translator('fr');
    expect(timeAgo(ago(10), t, 'fr', now)).toBe('à l’instant');
    expect(timeAgo(ago(5 * 60), t, 'fr', now)).toBe('il y a 5 min');
    expect(timeAgo(ago(26 * 3600), t, 'fr', now)).toBe('hier');
    expect(timeAgo(ago(3 * 86_400), await translator('en'), 'en', now)).toBe('3 days ago');
  });
});
