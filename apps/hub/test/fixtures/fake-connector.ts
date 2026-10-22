import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import WebSocket from 'ws';
import { atLeast, MIRROR_APP_FROM } from '../../src/connectors/service';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Stands in for the desktop app's connector (docs/DESKTOP.md): it shares folders and answers the
 * hub's requests on them, like the app of `FakeConnector.version` would (put, delete, mirror
 * manifests and watch from 0.2.5; base64 writes from 0.2.4). Commands are not run: their answer
 * repeats them.
 */
export class FakeConnector {
  /** The commit the shared folder is at (null: not a git repository). */
  static head: string | null = 'abc1234def5678';
  /** The app version it says it is (some ops depend on it). */
  static version = '0.0.0-test';
  /** Files bigger than this are left out of manifests (the app's limit is 20 MB). */
  static maxFile = 20 * 1024 * 1024;
  /** What the user picks when the hub opens the folder picker (null: cancels). */
  static picked: { key: string; name: string; path: string; root: string } | null = null;
  readonly socket: WebSocket;
  readonly requests: { op: string; args: Record<string, unknown> }[] = [];
  /** The projects the hub last asked to watch. */
  watched: string[] | null = null;
  private constructor(
    socket: WebSocket,
    private readonly projects: { key: string; name: string; path: string }[],
    private readonly roots: Record<string, string>,
  ) {
    this.socket = socket;
  }

  static async connect(
    url: string,
    token: string,
    projects: { key: string; name: string; path: string }[],
    roots: Record<string, string>,
  ): Promise<FakeConnector> {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const connector = new FakeConnector(socket, [...projects], { ...roots });
    const version = FakeConnector.version;
    socket.on('message', (data: WebSocket.RawData) => {
      const req = JSON.parse(data.toString()) as {
        t: string;
        id: string;
        op: string;
        project: string;
        args: Record<string, unknown>;
        projects?: string[];
      };
      if (req.t === 'watch') {
        connector.watched = req.projects ?? [];
        return;
      }
      if (req.t === 'pick') {
        void connector.pick(req.id);
        return;
      }
      if (req.t !== 'req') return;
      connector.requests.push({ op: req.op, args: req.args });
      const root = connector.roots[req.project];
      const answer = root
        ? run(root, req.op, req.args, version).then(
            (data) => ({ t: 'res', id: req.id, ok: true, data }),
            (error: Error) => ({ t: 'res', id: req.id, ok: false, error: error.message }),
          )
        : Promise.resolve({ t: 'res', id: req.id, ok: false, error: 'Projet inconnu' });
      void answer.then((res) => socket.send(JSON.stringify(res)));
    });
    socket.send(
      JSON.stringify({
        t: 'hello',
        version,
        hostname: 'PC-de-test',
        os: 'linux',
        shell: 'bash',
        projects,
      }),
    );
    return connector;
  }

  /** The app's watcher: these files changed in the project (null: anything). */
  changed(key: string, paths: string[] | null): void {
    this.socket.send(JSON.stringify({ t: 'changed', project: key, paths }));
  }

  /** The folder picker: the folder picked is shared (announced), then the answer goes. */
  private async pick(id: string): Promise<void> {
    const picked = FakeConnector.picked;
    if (picked) {
      this.projects.push({ key: picked.key, name: picked.name, path: picked.path });
      this.roots[picked.key] = picked.root;
      this.socket.send(JSON.stringify({ t: 'projects', projects: this.projects }));
    }
    const data = picked ? { key: picked.key, name: picked.name, path: picked.path } : null;
    this.socket.send(JSON.stringify({ t: 'res', id, ok: true, data }));
  }

  close(): void {
    this.socket.close();
  }
}

/** The files the app would list: .gitignore files followed, names left out, `.git` skipped. */
async function walk(
  root: string,
  exclude: Set<string>,
  visit: (rel: string, abs: string) => Promise<void>,
): Promise<void> {
  const go = async (dir: string, rel: string, rules: { base: string; ig: Ignore }[]) => {
    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null);
    const here =
      gitignore === null ? rules : [...rules, { base: rel, ig: ignore().add(gitignore) }];
    for (const name of (await readdir(dir)).sort()) {
      if (name === '.git' || exclude.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      const directory = (await stat(abs)).isDirectory();
      const ignored = here.some(({ base, ig }) => {
        const local = base ? childRel.slice(base.length + 1) : childRel;
        return ig.ignores(directory ? `${local}/` : local);
      });
      if (ignored) continue;
      if (directory) await go(abs, childRel, here);
      else await visit(childRel, abs);
    }
  };
  await go(root, '', []);
}

async function run(
  root: string,
  op: string,
  args: Record<string, unknown>,
  version: string,
): Promise<unknown> {
  const modern = atLeast(version, MIRROR_APP_FROM);
  const at = (rel: unknown) => {
    const resolved = path.resolve(root, String(rel ?? ''));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Chemin hors du projet : ${String(rel)}`);
    }
    return resolved;
  };
  const hashOf = async (rel: string) => {
    const content = await readFile(at(rel)).catch(() => null);
    return content ? sha256(content) : null;
  };
  switch (op) {
    case 'list': {
      const dir = at(args.path);
      const names = await readdir(dir);
      return {
        entries: await Promise.all(
          names.map(async (name) => {
            const info = await stat(path.join(dir, name));
            return {
              name,
              path: name,
              type: info.isDirectory() ? 'directory' : 'file',
              size: info.size,
            };
          }),
        ),
      };
    }
    case 'read': {
      const text = await readFile(at(args.path), 'utf8');
      return { text, totalLines: text.split('\n').length, truncated: false };
    }
    case 'write': {
      const file = at(args.path);
      await mkdir(path.dirname(file), { recursive: true });
      // Before 0.2.4 the app did not know base64: it wrote the text it got.
      const content =
        args.base64 && atLeast(version, [0, 2, 4])
          ? Buffer.from(String(args.content), 'base64')
          : Buffer.from(String(args.content));
      await writeFile(file, content);
      return { size: content.length };
    }
    case 'edit': {
      const file = at(args.path);
      const text = await readFile(file, 'utf8');
      const old = String(args.old);
      const count = text.split(old).length - 1;
      if (count === 0) throw new Error(`Texte introuvable dans ${String(args.path)}`);
      if (count > 1 && !args.all) throw new Error(`Texte présent ${count} fois`);
      await writeFile(file, text.split(old).join(String(args.new)));
      return { replaced: args.all ? count : 1 };
    }
    case 'search': {
      const pattern = new RegExp(String(args.pattern));
      const matches: { path: string; line: number; text: string }[] = [];
      for (const name of await readdir(root)) {
        const info = await stat(path.join(root, name));
        if (!info.isFile()) continue;
        const lines = (await readFile(path.join(root, name), 'utf8')).split('\n');
        lines.forEach((text, i) => {
          if (pattern.test(text)) matches.push({ path: name, line: i + 1, text });
        });
      }
      return { matches, truncated: false };
    }
    case 'exec':
      return { exitCode: 0, stdout: `ran: ${String(args.command)}`, stderr: '', timedOut: false };
    case 'manifest': {
      // Older apps ignored the mirror's arguments (names, paths) and did not say what they left
      // out.
      const exclude = new Set(modern ? ((args.exclude as string[] | undefined) ?? []) : []);
      const only = modern ? (args.paths as string[] | undefined) : undefined;
      const files: { path: string; size: number; hash: string }[] = [];
      const skipped: string[] = [];
      await walk(at(args.path), exclude, async (rel, abs) => {
        if (only && !only.some((p) => rel === p || rel.startsWith(`${p}/`))) return;
        const data = await readFile(abs);
        if (data.length > FakeConnector.maxFile) {
          skipped.push(rel);
          return;
        }
        files.push({ path: rel, size: data.length, hash: sha256(data) });
      });
      return modern
        ? {
            files,
            skipped,
            head: only ? null : FakeConnector.head,
            truncated: skipped.length > 0,
            complete: true,
          }
        : { files, head: FakeConnector.head, truncated: skipped.length > 0 };
    }
    case 'read_files':
      return {
        files: await Promise.all(
          (args.paths as string[]).map(async (rel) => ({
            path: rel,
            data: (await readFile(at(rel))).toString('base64'),
          })),
        ),
      };
    case 'put': {
      if (!modern) throw new Error(`Opération inconnue : ${op}`);
      const results = [];
      for (const file of args.files as {
        path: string;
        data: string;
        expect?: string | null;
      }[]) {
        if (file.path.split('/').includes('.git')) {
          results.push({
            path: file.path,
            ok: false,
            error: 'Le dossier .git n’est jamais modifié',
          });
          continue;
        }
        const current = await hashOf(file.path);
        if (file.expect !== undefined && current !== file.expect) {
          results.push({ path: file.path, ok: false, changed: true, current });
          continue;
        }
        const target = at(file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.data, 'base64'));
        results.push({ path: file.path, ok: true });
      }
      return { results };
    }
    case 'delete': {
      if (!modern) throw new Error(`Opération inconnue : ${op}`);
      const results = [];
      for (const file of args.files as { path: string; expect?: string }[]) {
        const current = await hashOf(file.path);
        if (current === null) {
          results.push({ path: file.path, ok: true, gone: true });
          continue;
        }
        if (file.expect !== undefined && current !== file.expect) {
          results.push({ path: file.path, ok: false, changed: true, current });
          continue;
        }
        await rm(at(file.path));
        results.push({ path: file.path, ok: true, trashed: false });
      }
      return { results };
    }
    default:
      throw new Error(`Opération inconnue : ${op}`);
  }
}
