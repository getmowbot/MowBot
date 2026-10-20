import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerEvent, Team } from '@mowbot/contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizePath } from '../src/workspaces/files';
import { bearer, createTestApp, multipart, setupOwner } from './helpers';

let t: Awaited<ReturnType<typeof createTestApp>>;
let token: string;
let team: Team;
let base: string;
let wsDir: string;

beforeEach(async () => {
  t = await createTestApp();
  token = (await setupOwner(t.app)).accessToken;
  team = (
    await t.app.inject({ method: 'GET', url: '/api/v1/teams', headers: bearer(token) })
  ).json().items[0];
  base = `/api/v1/workspaces/${team.workspaceId}`;
  wsDir = path.join(t.workspacesDir, team.workspaceId);
});

afterEach(async () => {
  await t.close();
});

const list = (dir = '') =>
  t.app.inject({
    method: 'GET',
    url: `${base}/files?path=${encodeURIComponent(dir)}`,
    headers: bearer(token),
  });

const upload = (dir: string, files: { name: string; content: string | Buffer }[]) => {
  const body = multipart(files);
  return t.app.inject({
    method: 'POST',
    url: `${base}/files/upload?path=${encodeURIComponent(dir)}`,
    headers: { ...bearer(token), ...body.headers },
    payload: body.payload,
  });
};

const content = (file: string, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'GET',
    url: `${base}/files/content?path=${encodeURIComponent(file)}`,
    headers: { ...bearer(token), ...headers },
  });

describe('normalizePath', () => {
  it('normalizes separators and rejects escapes', () => {
    expect(normalizePath('/shared//notes/./a.md')).toBe('shared/notes/a.md');
    expect(normalizePath('shared\\b.txt')).toBe('shared/b.txt');
    expect(normalizePath('')).toBe('');
    expect(() => normalizePath('../etc/passwd')).toThrow();
    expect(() => normalizePath('shared/../../x')).toThrow();
    expect(() => normalizePath('C:/Windows')).toThrow();
  });
});

describe('workspace files', () => {
  it('lists folders first', async () => {
    await writeFile(path.join(wsDir, 'readme.md'), '# hi');
    const res = await list();
    expect(res.statusCode).toBe(200);
    const names = res.json().entries.map((e: { name: string }) => e.name);
    expect(names).toEqual(['.trash', 'bots', 'inbox', 'kb', 'outputs', 'shared', 'readme.md']);
  });

  it('shows files a bot wrote from inside its computer', async () => {
    await writeFile(path.join(wsDir, 'outputs', 'rapport.txt'), 'fait par un bot');
    const entries = (await list('outputs')).json().entries;
    expect(entries).toEqual([
      expect.objectContaining({
        name: 'rapport.txt',
        path: 'outputs/rapport.txt',
        type: 'file',
        size: 15,
      }),
    ]);
  });

  it('uploads without overwriting and publishes a change event', async () => {
    const events: ServerEvent[] = [];
    t.services.events.subscribe((e) => events.push(e));

    const first = await upload('inbox', [{ name: 'note é.txt', content: 'v1' }]);
    expect(first.statusCode).toBe(200);
    const second = await upload('inbox', [{ name: 'note é.txt', content: 'v2' }]);
    expect(second.json().entries[0].name).toBe('note é (1).txt');

    expect(await readFile(path.join(wsDir, 'inbox', 'note é.txt'), 'utf8')).toBe('v1');
    expect(events).toContainEqual({
      type: 'workspace.changed',
      workspaceId: team.workspaceId,
      paths: ['inbox'],
    });
  });

  it('serves content with defensive headers and ranges', async () => {
    await writeFile(path.join(wsDir, 'shared', 'page.html'), '<script>alert(1)</script>');
    await writeFile(path.join(wsDir, 'shared', 'data.txt'), '0123456789');

    const html = await content('shared/page.html');
    expect(html.headers['content-type']).toContain('text/plain');
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['content-security-policy']).toContain('sandbox');

    const partial = await content('shared/data.txt', { range: 'bytes=2-4' });
    expect(partial.statusCode).toBe(206);
    expect(partial.body).toBe('234');
    expect(partial.headers['content-range']).toBe('bytes 2-4/10');
  });

  it('creates, renames and trashes', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: `${base}/files/mkdir`,
      headers: bearer(token),
      payload: { path: 'shared/projet' },
    });
    expect(created.statusCode).toBe(201);

    const moved = await t.app.inject({
      method: 'POST',
      url: `${base}/files/move`,
      headers: bearer(token),
      payload: { from: 'shared/projet', to: 'outputs/projet-final' },
    });
    expect(moved.json()).toMatchObject({ path: 'outputs/projet-final', type: 'directory' });

    const trashed = await t.app.inject({
      method: 'DELETE',
      url: `${base}/files?path=outputs/projet-final`,
      headers: bearer(token),
    });
    const { trashedTo } = trashed.json();
    expect(trashedTo).toMatch(/^\.trash\/.+-projet-final$/);

    const purged = await t.app.inject({
      method: 'DELETE',
      url: `${base}/files?path=${encodeURIComponent(trashedTo)}`,
      headers: bearer(token),
    });
    expect(purged.json()).toEqual({ trashedTo: null });
    expect((await list('.trash')).json().entries).toEqual([]);
  });

  it('refuses to move a folder into itself or over an existing path', async () => {
    const intoItself = await t.app.inject({
      method: 'POST',
      url: `${base}/files/move`,
      headers: bearer(token),
      payload: { from: 'shared', to: 'shared/inner' },
    });
    expect(intoItself.statusCode).toBe(400);
    const overExisting = await t.app.inject({
      method: 'POST',
      url: `${base}/files/move`,
      headers: bearer(token),
      payload: { from: 'shared', to: 'kb' },
    });
    expect(overExisting.statusCode).toBe(409);
  });

  it('rejects paths outside the workspace', async () => {
    expect((await list('../')).statusCode).toBe(400);
    expect((await content('../../etc/passwd')).statusCode).toBe(400);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow symlinks out of the workspace',
    async () => {
      await symlink('/etc', path.join(wsDir, 'shared', 'escape'));
      expect((await list('shared/escape')).statusCode).toBe(400);
      expect((await content('shared/escape/hostname')).statusCode).toBe(400);
      // Symlinks are not listed at all.
      expect((await list('shared')).json().entries).toEqual([]);
    },
  );

  it('downloads a file or a zipped folder through a single-use link', async () => {
    await writeFile(path.join(wsDir, 'outputs', 'résultat.csv'), 'a,b\n1,2\n');

    const ticketFor = async (p: string) =>
      (
        await t.app.inject({
          method: 'POST',
          url: `${base}/files/download-ticket`,
          headers: bearer(token),
          payload: { path: p },
        })
      ).json().ticket;

    const fileTicket = await ticketFor('outputs/résultat.csv');
    const file = await t.app.inject({ method: 'GET', url: `/api/v1/downloads/${fileTicket}` });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('a,b\n1,2\n');
    expect(file.headers['content-disposition']).toContain("filename*=UTF-8''r%C3%A9sultat.csv");

    const again = await t.app.inject({ method: 'GET', url: `/api/v1/downloads/${fileTicket}` });
    expect(again.statusCode).toBe(404);

    const zip = await t.app.inject({
      method: 'GET',
      url: `/api/v1/downloads/${await ticketFor('outputs')}`,
    });
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });

  it('requires files:write to modify', async () => {
    const me = (
      await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: bearer(token) })
    ).json();
    const { token: readOnly } = await t.services.tokens.sign({
      ownerId: me.owner.id,
      deviceId: me.device.id,
      scopes: ['read', 'files:read'],
    });
    expect(
      (await t.app.inject({ method: 'GET', url: `${base}/files`, headers: bearer(readOnly) }))
        .statusCode,
    ).toBe(200);
    const mkdir = await t.app.inject({
      method: 'POST',
      url: `${base}/files/mkdir`,
      headers: bearer(readOnly),
      payload: { path: 'nope' },
    });
    expect(mkdir.statusCode).toBe(403);
  });
});
