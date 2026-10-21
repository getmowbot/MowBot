import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

/**
 * Stands in for the desktop app's connector (docs/DESKTOP.md): it shares a folder and answers
 * the hub's requests on it. Commands are not run: their answer repeats them.
 */
export class FakeConnector {
  /** The commit the shared folder is at (null: not a git repository). */
  static head: string | null = 'abc1234def5678';
  /** The app version it says it is (some ops depend on it). */
  static version = '0.0.0-test';
  readonly socket: WebSocket;
  readonly requests: { op: string; args: Record<string, unknown> }[] = [];

  private constructor(socket: WebSocket) {
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
    const connector = new FakeConnector(socket);
    socket.on('message', (data: WebSocket.RawData) => {
      const req = JSON.parse(data.toString()) as {
        t: string;
        id: string;
        op: string;
        project: string;
        args: Record<string, unknown>;
      };
      if (req.t !== 'req') return;
      connector.requests.push({ op: req.op, args: req.args });
      const root = roots[req.project];
      const answer = root
        ? run(root, req.op, req.args).then(
            (data) => ({ t: 'res', id: req.id, ok: true, data }),
            (error: Error) => ({ t: 'res', id: req.id, ok: false, error: error.message }),
          )
        : Promise.resolve({ t: 'res', id: req.id, ok: false, error: 'Projet inconnu' });
      void answer.then((res) => socket.send(JSON.stringify(res)));
    });
    socket.send(
      JSON.stringify({
        t: 'hello',
        version: FakeConnector.version,
        hostname: 'PC-de-test',
        os: 'linux',
        shell: 'bash',
        projects,
      }),
    );
    return connector;
  }

  close(): void {
    this.socket.close();
  }
}

async function run(root: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  const at = (rel: unknown) => {
    const resolved = path.resolve(root, String(rel ?? ''));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Chemin hors du projet : ${String(rel)}`);
    }
    return resolved;
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
      const content = args.base64
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
      // Like the real one: .git and node_modules skipped (no .gitignore parsing here).
      const files: { path: string; size: number; hash: string }[] = [];
      const walk = async (dir: string, rel: string) => {
        for (const name of await readdir(dir)) {
          if (name === '.git' || name === 'node_modules') continue;
          const childRel = rel ? `${rel}/${name}` : name;
          const info = await stat(path.join(dir, name));
          if (info.isDirectory()) await walk(path.join(dir, name), childRel);
          else {
            const data = await readFile(path.join(dir, name));
            files.push({
              path: childRel,
              size: data.length,
              hash: createHash('sha256').update(data).digest('hex'),
            });
          }
        }
      };
      await walk(at(args.path), args.path ? String(args.path) : '');
      return { files, head: FakeConnector.head, truncated: false };
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
    case 'branch':
      return { branch: String(args.name), commit: 'c0ffee1234567890' };
    default:
      throw new Error(`Opération inconnue : ${op}`);
  }
}
