import type { Bot, Message, Question, VaultEvent, VaultItem } from '@mowbot/contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { MASK, maskIn, SecretScope } from '../src/vault/secrets';
import { type Cookie, changedSites, fingerprint, serviceName, siteOf } from '../src/vault/sites';
import { parseTotp, totpCode } from '../src/vault/totp';
import { bearer, createTestApp, setupOwner } from './helpers';
import { promptOf, scriptedBy, type Turn, textTurn, toolTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(chefModel?: MockLanguageModelV4) {
  t = await createTestApp({}, undefined, chefModel ? () => chefModel : undefined);
  const { app, services, runtime } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const inject = async <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = auth,
  ) => {
    const res = await app.inject({ method, url, headers, payload: payload as object });
    return { status: res.statusCode, raw: res.body, body: (res.body ? res.json() : null) as T };
  };
  const chef = (await inject<{ items: Bot[] }>('GET', '/api/v1/bots')).body.items[0] as Bot;
  const say = async (text: string) => {
    await inject('POST', `/api/v1/bots/${chef.id}/messages`, { text });
    await services.runtime.settle();
  };
  const transcript = async () =>
    (await inject<{ items: Message[] }>('GET', `/api/v1/bots/${chef.id}/messages`)).body.items;
  const history = async (id: string) =>
    (await inject<{ items: VaultEvent[] }>('GET', `/api/v1/vault/items/${id}/events`)).body.items;
  return { inject, chef, say, transcript, history, services, runtime };
}

const cookie = (name: string, value: string, domain: string, httpOnly = true): Cookie => ({
  name,
  value,
  domain,
  path: '/',
  expires: -1,
  httpOnly,
  secure: true,
  sameSite: 'Lax',
});

describe('vault helpers', () => {
  it('groups addresses and cookies by site', () => {
    expect(siteOf('https://accounts.google.com/signin?x=1')).toBe('google.com');
    expect(siteOf('.mail.google.com')).toBe('google.com');
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(siteOf('badnet.fr')).toBe('badnet.fr');
    expect(siteOf('https://the-internet.herokuapp.com/login')).toBe('the-internet.herokuapp.com');
    expect(siteOf('http://192.168.1.20:8080/')).toBe('192.168.1.20');
    expect(siteOf('')).toBeNull();
    expect(serviceName('google.com')).toBe('Google');
  });

  it('spots the sites where a login left new server cookies', () => {
    const before = fingerprint([
      cookie('NID', 'a', '.google.com'),
      cookie('_ga', 'x', '.news.fr', false),
      cookie('__cf_bm', 'old', '.badnet.fr'),
    ]);
    const after = fingerprint([
      cookie('NID', 'a', '.google.com'),
      cookie('SID', 'new', '.google.com'),
      cookie('_ga', 'y', '.news.fr', false),
      cookie('__cf_bm', 'rotated', '.badnet.fr'),
      cookie('session', 'abc', 'www.badnet.fr'),
      cookie('PHPSESSID', 'p', 'shop.example'),
    ]);
    // news.fr: analytics only (set by scripts); badnet.fr: a session cookie beside the noise.
    expect(changedSites(before, after)).toEqual(['badnet.fr', 'google.com', 'shop.example']);
    expect(changedSites(after, after)).toEqual([]);
  });

  it('computes 2FA codes (RFC 6238)', () => {
    const seed = parseTotp(
      'otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&issuer=Test',
    );
    expect(totpCode(seed, 59_000)).toBe('94287082');
    expect(totpCode(seed, 1_111_111_109_000)).toBe('07081804');
    expect(totpCode(parseTotp('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'), 59_000)).toBe('287082');
    expect(() => parseTotp('not base32 !')).toThrow();
  });

  it('masks secrets anywhere in an output', () => {
    const output = { stdout: 'token=s3cr3t-value ok', list: ['s3cr3t-value'], code: 0 };
    expect(maskIn(output, ['s3cr3t-value'])).toEqual({
      stdout: `token=${MASK} ok`,
      list: [MASK],
      code: 0,
    });
  });

  it('fills placeholders in and remembers what to mask', async () => {
    const scope = new SecretScope({
      reveal: async (ref, field) => ({
        value: field === 'username' ? 'joris' : `pw-of-${ref}`,
        secret: field !== 'username',
      }),
    });
    expect(
      await scope.expand(
        'login {{vault:abcd1234.username}} {{ vault:ABCD1234.password }} again {{vault:abcd1234.password}}',
      ),
    ).toBe('login joris pw-of-abcd1234 again pw-of-abcd1234');
    expect(scope.mask('echo pw-of-abcd1234 for joris')).toBe(`echo ${MASK} for joris`);
    expect(await scope.expand('no placeholder')).toBe('no placeholder');
  });
});

describe('vault API', () => {
  it('stores logins and secrets without ever sending their values back', async () => {
    const { inject, history } = await start();
    const created = await inject<VaultItem>('POST', '/api/v1/vault/items', {
      kind: 'login',
      service: 'BadNet',
      account: 'joris@example.com',
      sites: ['https://www.badnet.fr/login'],
      username: 'joris',
      password: 'hunter2-very-secret',
      totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'login',
      service: 'BadNet',
      sites: ['badnet.fr'],
      fields: ['username', 'password', 'totp'],
      policy: 'auto',
      ref: created.body.id.slice(0, 8),
    });
    expect(created.raw).not.toContain('hunter2');

    const list = await inject<{ items: VaultItem[] }>('GET', '/api/v1/vault/items');
    expect(list.body.items).toHaveLength(1);
    expect(list.raw).not.toContain('hunter2');
    expect(list.raw).not.toContain('GEZDGNBV');

    const updated = await inject<VaultItem>('PATCH', `/api/v1/vault/items/${created.body.id}`, {
      policy: 'ask',
      totp: null,
      password: 'another-password',
    });
    expect(updated.body).toMatchObject({ policy: 'ask', fields: ['username', 'password'] });
    expect((await history(created.body.id)).map((e) => e.action)).toEqual(['updated', 'created']);

    const badSeed = await inject('POST', '/api/v1/vault/items', {
      kind: 'login',
      service: 'X',
      totp: 'not a seed!',
    });
    expect(badSeed.status).toBe(400);
    const empty = await inject('POST', '/api/v1/vault/items', { kind: 'login', service: 'X' });
    expect(empty.status).toBe(400);
    const anonymous = await inject('GET', '/api/v1/vault/items', undefined, {});
    expect(anonymous.status).toBe(401);

    expect((await inject('DELETE', `/api/v1/vault/items/${created.body.id}`)).status).toBe(204);
    expect((await inject<{ items: VaultItem[] }>('GET', '/api/v1/vault/items')).body.items).toEqual(
      [],
    );
  });

  it('needs a running computer to save a session', async () => {
    const { inject, services } = await start();
    const [pc] = await services.computers.list();
    const capture = await inject('POST', '/api/v1/vault/sessions', {
      computerId: pc?.id,
      site: 'google.com',
    });
    expect(capture.status).toBe(409);
  });
});

describe('vault in the bots’ hands', () => {
  it('fills a secret into a command and masks it in what comes back', async () => {
    const ref = { value: '' };
    const model = scriptedBy((_prompt, call): Turn => {
      if (call === 0) {
        return toolTurn('bash', {
          command: `curl -H "Authorization: Bearer {{vault:${ref.value}.value}}" https://api.example`,
        });
      }
      return textTurn('Fait.');
    });
    const { inject, say, transcript, history, runtime } = await start(model);
    runtime.echoCommands = true;
    const item = await inject<VaultItem>('POST', '/api/v1/vault/items', {
      kind: 'secret',
      service: 'OpenWeather',
      value: 'ow-key-123456789',
    });
    ref.value = item.body.ref;

    await say('Appelle l’API météo');

    expect(runtime.commands.some((c) => c.includes('Bearer ow-key-123456789'))).toBe(true);
    const messages = await transcript();
    const tool = messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool' && p.toolName === 'bash');
    expect(tool).toMatchObject({ state: 'done' });
    const shown = JSON.stringify(tool);
    expect(shown).toContain(MASK);
    expect(shown).not.toContain('ow-key-123456789');
    // The model saw the placeholder in its call and the mask in the result, never the value.
    expect(promptOf(model, 1)).not.toContain('ow-key-123456789');
    expect(promptOf(model, 0)).toContain(`[${item.body.ref}] OpenWeather`);
    expect((await history(item.body.id))[0]).toMatchObject({ action: 'used', detail: 'value' });
  });

  it('asks the user before a bot uses an entry marked “ask”, then remembers the answer', async () => {
    const ref = { value: '' };
    const model = scriptedBy((_prompt, call): Turn => {
      const use = toolTurn('bash', { command: `login --password {{vault:${ref.value}.password}}` });
      return (
        [use, textTurn('J’attends ton accord.'), use, textTurn('Connecté.')][call] ??
        textTurn('Ok.')
      );
    });
    const { inject, say, history, runtime, chef } = await start(model);
    const item = await inject<VaultItem>('POST', '/api/v1/vault/items', {
      kind: 'login',
      service: 'Banque',
      username: 'joris',
      password: 'bank-password-42',
      policy: 'ask',
    });
    ref.value = item.body.ref;

    await say('Connecte-toi à la banque');
    expect(runtime.commands.some((c) => c.includes('bank-password-42'))).toBe(false);
    const [asked] = (await inject<{ items: Question[] }>('GET', '/api/v1/questions')).body.items;
    expect(asked).toMatchObject({ options: ['Autoriser', 'Refuser'], botId: chef.id });

    await inject('POST', `/api/v1/questions/${asked?.id}/answer`, { answer: 'Autoriser' });
    await t?.services.runtime.settle();

    expect(runtime.commands.some((c) => c.includes('bank-password-42'))).toBe(true);
    const after = await inject<VaultItem>('GET', '/api/v1/vault/items');
    expect(JSON.stringify(after.body)).toContain(chef.id);
    expect((await history(item.body.id)).map((e) => e.action)).toEqual([
      'used',
      'granted',
      'requested',
      'created',
    ]);

    const revoked = await inject<VaultItem>(
      'DELETE',
      `/api/v1/vault/items/${item.body.id}/grants/${chef.id}`,
    );
    expect(revoked.body.grantedBotIds).toEqual([]);
  });
});
