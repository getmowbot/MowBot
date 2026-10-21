import type { Notification, Task, VaultItem } from '@mowbot/contract';
import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { translator, vaultEvent, vaultItem } from '../test/fixtures';
import type { NotificationList } from './board';
import { applyServerEvent } from './event-cache';
import { keys } from './query-keys';
import {
  computerName,
  createBody,
  detailText,
  EMPTY_LABELS,
  EMPTY_VALUES,
  eventText,
  fieldsText,
  filterSites,
  groupVault,
  itemChanges,
  itemHint,
  itemLabel,
  labelDraft,
  newItemProblem,
  parseSites,
  placeholder,
  placeholders,
  REQUEST_INPUTS,
  removableFields,
  removeFieldBody,
  requestFields,
  requestProblem,
  requestValues,
  serviceName,
  sessionContents,
  siteHint,
} from './vault';

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  fr = await translator('fr');
  en = await translator('en');
});

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const computers = [{ id: 'pc-1', name: 'PC de Nova' }];
const bots = new Map([['bot-1', { name: 'Nova' }]]);

describe('vault list', () => {
  it('groups sessions, logins then secrets, each by service and account', () => {
    const items = [
      vaultItem({ kind: 'secret', service: 'OpenWeather' }),
      vaultItem({ kind: 'login', service: 'github', account: 'b' }),
      vaultItem({ kind: 'session', service: 'Google' }),
      vaultItem({ kind: 'login', service: 'GitHub', account: 'a' }),
      vaultItem({ kind: 'login', service: 'Amazon' }),
    ];
    const groups = groupVault(items);
    expect(groups.map((g) => g.kind)).toEqual(['session', 'login', 'secret']);
    expect(groups[1]?.items.map((i) => `${i.service}/${i.account ?? ''}`)).toEqual([
      'Amazon/',
      'GitHub/a',
      'github/b',
    ]);
    expect(groupVault([vaultItem({ kind: 'secret' })]).map((g) => g.kind)).toEqual(['secret']);
    expect(groupVault([])).toEqual([]);
  });

  it('says where a session comes from and how fresh it is', () => {
    const session = vaultItem({
      kind: 'session',
      account: 'joris@gmail.com',
      sites: ['google.com'],
      fields: [],
      computerId: 'pc-1',
      capturedAt: minutesAgo(5),
    });
    expect(itemHint(session, { computers, t: fr, language: 'fr', now: NOW })).toBe(
      'joris@gmail.com · google.com\nPC de Nova · capturée il y a 5 min',
    );
    expect(itemHint(session, { computers, t: en, language: 'en', now: NOW })).toBe(
      'joris@gmail.com · google.com\nPC de Nova · captured 5 min ago',
    );
    const orphan = { ...session, account: null, sites: [], computerId: null, capturedAt: null };
    expect(itemHint(orphan, { computers, t: fr, language: 'fr', now: NOW })).toBe('PC supprimé');
  });

  it('says what a login or a secret holds', () => {
    const login = vaultItem({ fields: ['totp', 'username', 'password'], sites: ['github.com'] });
    expect(itemHint(login, { computers, t: fr, language: 'fr' })).toBe(
      'github.com\nNom d’utilisateur, mot de passe, 2FA',
    );
    expect(fieldsText(['value'], en)).toBe('Value');
    expect(itemLabel(vaultItem({ service: 'Google', account: 'me@x.fr' }))).toBe(
      'Google (me@x.fr)',
    );
    expect(itemLabel(vaultItem({ service: 'Google' }))).toBe('Google');
  });

  it('names computers and session contents', () => {
    expect(computerName('pc-1', computers, fr)).toBe('PC de Nova');
    expect(computerName('pc-2', computers, en)).toBe('Deleted PC');
    expect(computerName(null, undefined, fr)).toBe('PC supprimé');
    expect(sessionContents({ cookies: 12, origins: 1 }, fr)).toBe('12 cookies · 1 stockage local');
    expect(sessionContents({ cookies: 1, origins: 0 }, en)).toBe('1 cookie');
    expect(sessionContents(null, en)).toBeNull();
  });
});

describe('placeholders', () => {
  it('lists the stored values of a login in form order', () => {
    const login = vaultItem({ ref: '3f2a9c1b', fields: ['totp', 'username'] });
    expect(placeholders(login)).toEqual([
      { field: 'username', text: '{{vault:3f2a9c1b.username}}' },
      { field: 'totp', text: '{{vault:3f2a9c1b.totp}}' },
    ]);
    expect(placeholder('abcd1234', 'value')).toBe('{{vault:abcd1234.value}}');
  });

  it('gives a secret its value and a session none', () => {
    expect(placeholders(vaultItem({ kind: 'secret', ref: 'r', fields: ['value'] }))).toEqual([
      { field: 'value', text: '{{vault:r.value}}' },
    ]);
    expect(placeholders(vaultItem({ kind: 'session', fields: [] }))).toEqual([]);
  });
});

describe('history', () => {
  it('words each action with the bot, or the user', () => {
    const label = (overrides: Parameters<typeof vaultEvent>[0], t = fr) =>
      eventText(vaultEvent(overrides), { bots, computers }, t).label;
    expect(label({ action: 'created' })).toBe('Ajoutée par toi');
    expect(label({ action: 'created', botId: 'bot-1' }, en)).toBe('Added by Nova');
    expect(label({ action: 'updated' })).toBe('Modifiée');
    expect(label({ action: 'captured' })).toBe('Session capturée');
    expect(label({ action: 'captured', botId: 'bot-1' })).toBe('Session capturée par Nova');
    expect(label({ action: 'used', botId: 'bot-1' })).toBe('Utilisée par Nova');
    expect(label({ action: 'requested', botId: 'bot-1' })).toBe('Nova a demandé l’accès');
    expect(label({ action: 'granted', botId: 'bot-1' }, en)).toBe('Access granted to Nova');
    expect(label({ action: 'denied', botId: 'gone' })).toBe('Accès refusé à Bot supprimé');
    expect(label({ action: 'revoked', botId: 'bot-1' }, en)).toBe('Access revoked from Nova');
  });

  it('adds the PC and the hub’s detail, in the app’s language', () => {
    const used = vaultEvent({
      action: 'used',
      botId: 'bot-1',
      computerId: 'pc-1',
      detail: 'password',
    });
    expect(eventText(used, { bots, computers }, fr).hint).toBe('PC de Nova · mot de passe');
    const refreshed = vaultEvent({ action: 'captured', detail: 'refreshed' });
    expect(eventText(refreshed, { bots, computers }, en).hint).toBe('refreshed before use');
    expect(eventText(refreshed, { bots, computers }, fr).hint).toBe('rafraîchie avant usage');
    expect(eventText(vaultEvent({ action: 'updated' }), { bots, computers }, fr).hint).toBeNull();
    expect(detailText('values_replaced', en)).toBe('values replaced');
    expect(detailText('takeover_end', fr)).toBe('à la fin d’une prise de main');
    expect(detailText('totp', en)).toBe('2FA');
    // Older lines were written in French by the hub.
    expect(detailText('valeurs remplacées', en)).toBe('values replaced');
    expect(detailText('rafraîchie avant usage', en)).toBe('refreshed before use');
    expect(detailText('fin de prise de main', en)).toBe('at the end of a takeover');
    expect(detailText('autre chose', en)).toBe('autre chose');
    expect(detailText(null, en)).toBeNull();
  });
});

describe('vault forms', () => {
  it('reads sites typed with commas or spaces', () => {
    expect(parseSites(' Google.com, youtube.com  mail.google.com,,google.com ')).toEqual([
      'google.com',
      'youtube.com',
      'mail.google.com',
    ]);
    expect(parseSites('')).toEqual([]);
  });

  it('sends only what changed, values only when typed', () => {
    const item = vaultItem({
      service: 'Google',
      account: 'me@x.fr',
      sites: ['google.com'],
      notes: null,
    });
    const labels = labelDraft(item);
    expect(labels).toEqual({
      service: 'Google',
      account: 'me@x.fr',
      sites: 'google.com',
      notes: '',
    });
    expect(itemChanges(item, labels)).toEqual({});
    expect(
      itemChanges(item, {
        ...labels,
        service: ' Gmail ',
        account: ' ',
        sites: 'google.com, gmail.com',
      }),
    ).toEqual({ service: 'Gmail', account: null, sites: ['google.com', 'gmail.com'] });
    expect(
      itemChanges(item, labels, { ...EMPTY_VALUES, password: ' secret ', totp: ' JBSWY3DP ' }),
    ).toEqual({ password: ' secret ', totp: 'JBSWY3DP' });
  });

  it('replaces a secret’s value, never a session’s', () => {
    const secret = vaultItem({ kind: 'secret', fields: ['value'] });
    expect(itemChanges(secret, labelDraft(secret), { ...EMPTY_VALUES, value: ' sk-1 \n' })).toEqual(
      { value: 'sk-1' },
    );
    const session = vaultItem({ kind: 'session', fields: [] });
    expect(itemChanges(session, labelDraft(session), { ...EMPTY_VALUES, value: 'x' })).toEqual({});
  });

  it('checks a new login or secret', () => {
    const labels = { ...EMPTY_LABELS, service: 'GitHub' };
    expect(newItemProblem('login', EMPTY_LABELS, EMPTY_VALUES)).toBe('service');
    expect(newItemProblem('login', labels, EMPTY_VALUES)).toBe('login');
    expect(newItemProblem('login', labels, { ...EMPTY_VALUES, totp: 'JBSWY3DP' })).toBeNull();
    expect(newItemProblem('secret', labels, { ...EMPTY_VALUES, value: '  ' })).toBe('value');
    const many = Array.from({ length: 21 }, (_, i) => `s${i}.com`).join(',');
    expect(newItemProblem('secret', { ...labels, sites: many }, EMPTY_VALUES)).toBe('sites');
  });

  it('builds what creating sends, empty fields left out', () => {
    expect(
      createBody(
        'login',
        { service: ' GitHub ', account: '', sites: 'github.com', notes: ' ' },
        { ...EMPTY_VALUES, username: ' joris ', password: 'p w' },
        'ask',
      ),
    ).toEqual({
      kind: 'login',
      service: 'GitHub',
      sites: ['github.com'],
      policy: 'ask',
      username: 'joris',
      password: 'p w',
    });
    expect(
      createBody(
        'secret',
        { ...EMPTY_LABELS, service: 'OpenWeather' },
        {
          ...EMPTY_VALUES,
          value: 'key',
          password: 'ignored',
        },
        'auto',
      ),
    ).toEqual({ kind: 'secret', service: 'OpenWeather', policy: 'auto', value: 'key' });
  });

  it('removes a login value only while another stays', () => {
    expect(removableFields(vaultItem({ fields: ['username', 'totp'] }))).toEqual([
      'username',
      'totp',
    ]);
    expect(removableFields(vaultItem({ fields: ['password'] }))).toEqual([]);
    expect(removableFields(vaultItem({ kind: 'secret', fields: ['value'] }))).toEqual([]);
    expect(removeFieldBody('totp')).toEqual({ totp: null });
  });

  it('helps pick a site from a computer', () => {
    const sites = [
      { site: 'google.com', cookies: 40, itemId: 'x' },
      { site: 'github.com', cookies: 1, itemId: null },
    ];
    expect(filterSites(sites, ' GIT').map((s) => s.site)).toEqual(['github.com']);
    expect(filterSites(sites, '')).toHaveLength(2);
    expect(siteHint(sites[0] as (typeof sites)[number], fr)).toBe('40 cookies · déjà enregistrée');
    expect(siteHint(sites[1] as (typeof sites)[number], en)).toBe('1 cookie');
    expect(serviceName('google.com')).toBe('Google');
  });
});

describe('vault, activity and notification events', () => {
  it('keeps the vault live', () => {
    const client = new QueryClient();
    const first = vaultItem();
    client.setQueryData<VaultItem[]>(keys.vault, [first]);
    const changed = { ...first, service: 'Gmail' };
    applyServerEvent(client, { type: 'vault.updated', item: changed });
    const added = vaultItem({ kind: 'session' });
    applyServerEvent(client, { type: 'vault.updated', item: added });
    expect(client.getQueryData(keys.vault)).toEqual([changed, added]);
    client.setQueryData(keys.vaultEvents(first.id), []);
    applyServerEvent(client, { type: 'vault.deleted', itemId: first.id });
    expect(client.getQueryData(keys.vault)).toEqual([added]);
    expect(client.getQueryData(keys.vaultEvents(first.id))).toBeUndefined();
  });

  it('empties the notifications and the finished tasks', () => {
    const client = new QueryClient();
    client.setQueryData<NotificationList>(keys.notifications, {
      items: [{ id: 'n1' } as Notification],
      unread: 1,
    });
    applyServerEvent(client, { type: 'notifications.cleared' });
    expect(client.getQueryData(keys.notifications)).toEqual({ items: [], unread: 0 });

    const task = (status: Task['status']) => ({ id: status, status }) as Task;
    client.setQueryData<Task[]>(keys.tasks, [task('doing'), task('done'), task('cancelled')]);
    applyServerEvent(client, { type: 'activity.cleared' });
    expect(client.getQueryData<Task[]>(keys.tasks)?.map((t) => t.status)).toEqual(['doing']);
  });
});

describe('a bot’s vault request', () => {
  it('shows the requested fields in the usual order', () => {
    expect(requestFields({ fields: ['totp', 'username', 'password'] })).toEqual([
      'username',
      'password',
      'totp',
    ]);
    expect(requestFields({ fields: ['value'] })).toEqual(['value']);
  });

  it('sends only what was asked for and typed', () => {
    const values = { username: ' joris ', password: ' p w ', totp: '', value: 'stray' };
    expect(requestValues(['username', 'password', 'totp'], values)).toEqual({
      username: 'joris',
      // Passwords keep their spaces.
      password: ' p w ',
    });
    expect(requestValues(['value'], { ...EMPTY_VALUES, value: '  sk-123 ' })).toEqual({
      value: 'sk-123',
    });
    expect(requestValues(['username', 'password'], { ...EMPTY_VALUES, username: '  ' })).toBeNull();
  });

  it('masks secrets and never autofills a key', () => {
    expect(REQUEST_INPUTS.username.secure).toBe(false);
    expect(REQUEST_INPUTS.password.secure).toBe(true);
    expect(REQUEST_INPUTS.totp.textContentType).toBe('oneTimeCode');
    expect(REQUEST_INPUTS.value).toMatchObject({ secure: true, autoComplete: 'off' });
  });

  it('words what failed', () => {
    const problem = (code: string) => ({ type: `urn:mowbot:problem:${code}`, status: 400 });
    expect(requestProblem(problem('invalid_totp'))).toBe('invalid_totp');
    expect(requestProblem(problem('empty_answer'))).toBe('empty_answer');
    expect(requestProblem(problem('request_answered'))).toBe('answered');
    expect(requestProblem(new Error('offline'))).toBe('failed');
  });
});
