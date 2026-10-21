import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createTestApp, PASSWORD, SETUP_TOKEN, setupOwner, type TestApp } from './helpers';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

describe('system', () => {
  it('reports health', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('answers unknown routes with a problem document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 404, type: 'urn:mowbot:problem:not_found' });
  });

  it('serves an OpenAPI 3.1 document listing the auth routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/auth/login', '/api/v1/auth/refresh', '/api/v1/devices']),
    );
  });
});

describe('setup', () => {
  it('requires the setup token and only works once', async () => {
    let status = await t.app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(status.json()).toEqual({ setupRequired: true });

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupToken: 'nope',
        displayName: 'Joris',
        password: PASSWORD,
        device: { name: 'CLI', kind: 'cli' },
      },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().type).toBe('urn:mowbot:problem:invalid_setup_token');

    await setupOwner(t.app);
    status = await t.app.inject({ method: 'GET', url: '/api/v1/auth/status' });
    expect(status.json()).toEqual({ setupRequired: false });

    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupToken: SETUP_TOKEN,
        displayName: 'Mallory',
        password: PASSWORD,
        device: { name: 'CLI', kind: 'cli' },
      },
    });
    expect(again.statusCode).toBe(409);
  });

  it('rejects short passwords with a validation problem', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupToken: SETUP_TOKEN,
        displayName: 'Joris',
        password: 'short',
        device: { name: 'CLI', kind: 'cli' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ type: 'urn:mowbot:problem:validation_failed' });
    expect(res.json().errors.length).toBeGreaterThan(0);
  });
});

describe('login and access tokens', () => {
  beforeEach(async () => {
    await setupOwner(t.app);
  });

  it('rejects a wrong password', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong password!!', device: { name: 'Phone', kind: 'ios' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs a native device in and serves /me', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD, device: { name: 'iPhone', kind: 'ios' } },
    });
    expect(login.statusCode).toBe(200);
    const tokens = login.json();
    expect(tokens.refreshToken).toBeTypeOf('string');

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(tokens.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      owner: { displayName: 'Joris' },
      device: { id: tokens.deviceId, name: 'iPhone', kind: 'ios', current: true },
    });
  });

  it('requires a bearer token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    const garbage = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer('not-a-jwt'),
    });
    expect(garbage.statusCode).toBe(401);
  });

  it('enforces scopes', async () => {
    const tokens = await setupLessLogin();
    const { token } = await t.services.tokens.sign({
      ownerId: (await meOf(tokens.accessToken)).owner.id,
      deviceId: tokens.deviceId,
      scopes: ['read'],
    });
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    const revoke = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${tokens.deviceId}`,
      headers: bearer(token),
    });
    expect(revoke.statusCode).toBe(403);
  });
});

describe('web devices', () => {
  it('keeps the refresh token in an httpOnly cookie', async () => {
    const tokens = await setupOwner(t.app, { name: 'Chrome', kind: 'web' });
    expect(tokens.refreshToken).toBeUndefined();

    const relogin = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: PASSWORD, device: { name: 'Firefox', kind: 'web' } },
    });
    const cookie = relogin.cookies.find((c) => c.name === 'mowbot_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });

    const refreshed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: {},
      cookies: { mowbot_refresh: cookie?.value ?? '' },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).toBeUndefined();
    const rotated = refreshed.cookies.find((c) => c.name === 'mowbot_refresh');
    expect(rotated?.value).toBeTruthy();
    expect(rotated?.value).not.toBe(cookie?.value);
  });
});

describe('refresh token rotation', () => {
  it('rotates and rejects a token used twice within the grace window without revoking', async () => {
    const first = await setupOwner(t.app);
    const rotated = await refresh(first.refreshToken);
    expect(rotated.statusCode).toBe(200);

    const race = await refresh(first.refreshToken);
    expect(race.statusCode).toBe(401);
    expect(race.json().type).toBe('urn:mowbot:problem:refresh_token_race');

    // The legitimate successor still works.
    expect((await refresh(rotated.json().refreshToken)).statusCode).toBe(200);
  });

  it('revokes the device when a consumed token is replayed after the grace window', async () => {
    await t.close();
    t = await createTestApp({ refreshReuseGraceSec: 0 });
    const first = await setupOwner(t.app);
    const rotated = (await refresh(first.refreshToken)).json();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const replay = await refresh(first.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().type).toBe('urn:mowbot:problem:refresh_token_reused');

    // The whole family and the device are gone.
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(rotated.accessToken),
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('devices', () => {
  it('lists devices and revokes one immediately', async () => {
    const owner = await setupOwner(t.app);
    const phone = await setupLessLogin('Pixel', 'android');

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/v1/devices',
      headers: bearer(owner.accessToken),
    });
    expect(list.json().items).toHaveLength(2);

    const revoke = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${phone.deviceId}`,
      headers: bearer(owner.accessToken),
    });
    expect(revoke.statusCode).toBe(204);

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(phone.accessToken),
    });
    expect(me.statusCode).toBe(401);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);
  });

  it('logs out the calling device', async () => {
    const owner = await setupOwner(t.app);
    const logout = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: bearer(owner.accessToken),
    });
    expect(logout.statusCode).toBe(204);
    expect((await refresh(owner.refreshToken)).statusCode).toBe(401);
  });
});

function refresh(refreshToken: string | undefined) {
  return t.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
}

async function setupLessLogin(name = 'Laptop', kind: 'cli' | 'android' = 'cli') {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { password: PASSWORD, device: { name, kind } },
  });
  return res.json();
}

async function meOf(accessToken: string) {
  return (
    await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(accessToken) })
  ).json();
}

describe('changing the password', () => {
  it('needs the current one, and can sign out the other devices', async () => {
    const owner = await setupOwner(t.app);
    const login = (password: string, name: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password, device: { name, kind: 'ios' } },
      });
    const phone = (await login(PASSWORD, 'Téléphone')).json();
    const change = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/me/password',
        headers: bearer(owner.accessToken),
        payload,
      });

    const wrong = await change({ currentPassword: 'nope', newPassword: 'a new long password' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().type).toBe('urn:mowbot:problem:wrong_password');
    const short = await change({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(short.statusCode).toBe(400);

    const ok = await change({
      currentPassword: PASSWORD,
      newPassword: 'a new long password',
      signOutOthers: true,
    });
    expect(ok.statusCode).toBe(204);
    expect((await login(PASSWORD, 'Vieux')).statusCode).toBe(401);
    expect((await login('a new long password', 'Nouveau')).statusCode).toBe(200);
    // The phone is signed out; this device stays signed in.
    const me = (token: string) =>
      t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) });
    expect((await me(phone.accessToken)).statusCode).toBe(401);
    expect((await me(owner.accessToken)).statusCode).toBe(200);
  });
});
