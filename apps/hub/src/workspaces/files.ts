import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile as writeFsFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type FileEntry, TRASH_FOLDER, WORKSPACE_FOLDERS } from '@mowbot/contract';
import { ZipFile } from 'yazl';
import { HttpProblem, notFound } from '../http/problems';

const invalidPath = (detail = 'Invalid path') => new HttpProblem(400, 'invalid_path', detail);
const alreadyExists = (detail = 'Path already exists') =>
  new HttpProblem(409, 'already_exists', detail);

/** Folders a search does not go into: tools' caches, nobody looks for a file there. */
const SEARCH_SKIPPED = new Set(['node_modules', '.git', '.venv', '__pycache__', '.cache']);
const SEARCH_MAX_DEPTH = 8;
const SEARCH_MAX_VISITED = 5_000;

/** For matching: lower case, without accents. */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const isNotFound = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Normalizes a client path to a workspace-relative POSIX path (`''` = root). Rejects `..`,
 * NUL bytes and drive letters; leading slashes are ignored.
 */
export function normalizePath(input: string): string {
  if (input.includes('\0')) throw invalidPath();
  const segments = input
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..' || /^[a-zA-Z]:$/.test(segment))) {
    throw invalidPath();
  }
  return segments.join('/');
}

export const parentOf = (rel: string) =>
  rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** `report.pdf` → `report (1).pdf`, keeping dotfiles and extension-less names sensible. */
function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** `name`, or the first `name (n)` that is free in `dir`. */
async function freeName(dir: string, name: string): Promise<string> {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? name : numbered(name, n);
    if (!(await lstat(path.join(dir, candidate)).catch(() => null))) return candidate;
  }
}

/** Files of every workspace, stored under `<root>/<workspaceId>/`. */
export class WorkspaceFiles {
  constructor(readonly root: string) {}

  dirOf(workspaceId: string): string {
    return path.join(this.root, workspaceId);
  }

  /**
   * Moves a whole workspace into another one's trash (its team or solo bot was deleted), so
   * nothing is lost. Returns the path inside the target workspace.
   */
  async archiveInto(workspaceId: string, intoWorkspaceId: string, label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${label.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'archive'}`;
    await mkdir(path.join(this.dirOf(intoWorkspaceId), TRASH_FOLDER), { recursive: true });
    await rename(
      this.dirOf(workspaceId),
      path.join(this.dirOf(intoWorkspaceId), TRASH_FOLDER, name),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return `${TRASH_FOLDER}/${name}`;
  }

  /** Creates the workspace directory and its default folders. Idempotent. */
  async ensure(workspaceId: string): Promise<void> {
    const base = this.dirOf(workspaceId);
    for (const folder of [...WORKSPACE_FOLDERS, TRASH_FOLDER]) {
      await mkdir(path.join(base, folder), { recursive: true });
    }
  }

  /**
   * Maps a relative path to an absolute one and guarantees the result stays inside the
   * workspace even through symlinks (bots can create symlinks pointing anywhere).
   */
  private async resolve(workspaceId: string, input: string, mustExist: boolean) {
    const rel = normalizePath(input);
    const base = await realpath(this.dirOf(workspaceId)).catch((error) => {
      if (isNotFound(error)) throw notFound('Workspace directory not found');
      throw error;
    });
    const abs = rel ? path.join(base, ...rel.split('/')) : base;
    const anchor = mustExist ? abs : path.dirname(abs);
    const real = await realpath(anchor).catch((error) => {
      if (isNotFound(error)) throw notFound(mustExist ? 'File not found' : 'Folder not found');
      throw error;
    });
    if (real !== base && !real.startsWith(base + path.sep))
      throw invalidPath('Path escapes workspace');
    return { rel, abs, base };
  }

  private async entry(rel: string, abs: string): Promise<FileEntry | null> {
    const info = await lstat(abs);
    if (!info.isFile() && !info.isDirectory()) return null;
    return {
      name: path.basename(abs),
      path: rel,
      type: info.isDirectory() ? 'directory' : 'file',
      size: info.isDirectory() ? 0 : info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  }

  /** Lists a directory: folders first, then files, by name. Symlinks are not listed. */
  async list(workspaceId: string, dir: string): Promise<{ path: string; entries: FileEntry[] }> {
    const { rel, abs } = await this.resolve(workspaceId, dir, true);
    if (!(await stat(abs)).isDirectory()) throw invalidPath('Not a folder');
    const names = await readdir(abs);
    const entries = (
      await Promise.all(
        names.map((name) => this.entry(joinRel(rel, name), path.join(abs, name)).catch(() => null)),
      )
    ).filter((e): e is FileEntry => e !== null);
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name, 'fr') : a.type === 'directory' ? -1 : 1,
    );
    return { path: rel, entries };
  }

  /**
   * Files and folders whose path contains `query` (case and accents aside), names starting with
   * it first; without a query, the files changed last. The trash and heavy folders are skipped.
   */
  async search(workspaceId: string, query: string, limit = 20): Promise<FileEntry[]> {
    const { base } = await this.resolve(workspaceId, '', true);
    const needle = fold(query.trim());
    const found: FileEntry[] = [];
    let visited = 0;
    const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
      const names = await readdir(abs).catch(() => [] as string[]);
      for (const name of names) {
        if (++visited > SEARCH_MAX_VISITED) return;
        if ((!rel && name === TRASH_FOLDER) || SEARCH_SKIPPED.has(name)) continue;
        const childRel = joinRel(rel, name);
        const childAbs = path.join(abs, name);
        const entry = await this.entry(childRel, childAbs).catch(() => null);
        if (!entry) continue;
        if (needle ? fold(childRel).includes(needle) : entry.type === 'file') found.push(entry);
        if (entry.type === 'directory' && depth < SEARCH_MAX_DEPTH) {
          await walk(childAbs, childRel, depth + 1);
        }
      }
    };
    await walk(base, '', 0);
    if (!needle) {
      return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
    }
    const rank = (e: FileEntry) => (fold(e.name).startsWith(needle) ? 0 : 1);
    return found.sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length).slice(0, limit);
  }

  async stat(workspaceId: string, file: string): Promise<FileEntry & { abs: string }> {
    const { rel, abs } = await this.resolve(workspaceId, file, true);
    const found = await this.entry(rel, abs);
    if (!found) throw notFound('File not found');
    return { ...found, abs };
  }

  async mkdir(workspaceId: string, dir: string): Promise<FileEntry> {
    const { rel, abs } = await this.resolve(workspaceId, dir, false);
    if (!rel) throw invalidPath();
    try {
      await mkdir(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw alreadyExists();
      throw error;
    }
    return (await this.entry(rel, abs)) as FileEntry;
  }

  async move(workspaceId: string, from: string, to: string): Promise<FileEntry> {
    const source = await this.resolve(workspaceId, from, true);
    const target = await this.resolve(workspaceId, to, false);
    if (!source.rel || !target.rel) throw invalidPath();
    if (`${target.rel}/`.startsWith(`${source.rel}/`))
      throw invalidPath('Cannot move a folder into itself');
    if (await lstat(target.abs).catch(() => null)) throw alreadyExists();
    await rename(source.abs, target.abs);
    return (await this.entry(target.rel, target.abs)) as FileEntry;
  }

  /** Deletes a file for good (no trash): for copies the hub keeps in sync itself. */
  async unlink(workspaceId: string, file: string): Promise<void> {
    const { rel, abs } = await this.resolve(workspaceId, file, true);
    if (!rel || !(await lstat(abs)).isFile()) throw invalidPath('Not a file');
    await rm(abs, { force: true });
  }

  /** Moves to `.trash/`; deleting something already in the trash removes it for good. */
  async remove(workspaceId: string, file: string): Promise<{ trashedTo: string | null }> {
    const { rel, abs, base } = await this.resolve(workspaceId, file, true);
    if (!rel || rel === TRASH_FOLDER) throw invalidPath('Cannot delete this folder');
    if (rel.startsWith(`${TRASH_FOLDER}/`)) {
      await rm(abs, { recursive: true, force: true });
      return { trashedTo: null };
    }
    await mkdir(path.join(base, TRASH_FOLDER), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trashedTo = `${TRASH_FOLDER}/${stamp}-${path.basename(abs)}`;
    await rename(abs, path.join(base, ...trashedTo.split('/')));
    return { trashedTo };
  }

  /** Streams an upload into `dir`, renaming to `name (n).ext` instead of overwriting. */
  async write(
    workspaceId: string,
    dir: string,
    name: string,
    content: Readable,
  ): Promise<FileEntry> {
    const fileName = path.basename(name.replaceAll('\\', '/'));
    if (!fileName || fileName === '.' || fileName === '..' || fileName.includes('\0')) {
      throw invalidPath('Invalid file name');
    }
    const folder = await this.resolve(workspaceId, dir, true);
    if (!(await stat(folder.abs)).isDirectory()) throw invalidPath('Not a folder');

    const temp = path.join(folder.abs, `.mowbot-upload-${randomBytes(6).toString('hex')}`);
    try {
      await pipeline(content, createWriteStream(temp, { flags: 'wx' }));
      for (let n = 0; ; n++) {
        const candidate = n === 0 ? fileName : numbered(fileName, n);
        const target = path.join(folder.abs, candidate);
        if (await lstat(target).catch(() => null)) continue;
        await rename(temp, target);
        return (await this.entry(joinRel(folder.rel, candidate), target)) as FileEntry;
      }
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** Reads a text file, truncated to `maxBytes`. */
  async readText(
    workspaceId: string,
    file: string,
    maxBytes = 200_000,
  ): Promise<{ text: string; truncated: boolean; size: number }> {
    const found = await this.stat(workspaceId, file);
    if (found.type !== 'file') throw invalidPath('Not a file');
    const buffer = await readFile(found.abs);
    return {
      text: buffer.subarray(0, maxBytes).toString('utf8'),
      truncated: buffer.length > maxBytes,
      size: buffer.length,
    };
  }

  /** Creates a folder and its missing parents, never through a symlink leading outside. */
  private async ensureFolder(
    workspaceId: string,
    dir: string,
  ): Promise<{ rel: string; abs: string }> {
    const rel = normalizePath(dir);
    const base = await realpath(this.dirOf(workspaceId));
    // Validate the deepest existing ancestor before creating anything (symlinks included).
    const segments = rel ? rel.split('/') : [];
    let existing = base;
    for (const segment of segments) {
      const candidate = path.join(existing, segment);
      const info = await lstat(candidate).catch(() => null);
      if (!info) break;
      existing = await realpath(candidate);
      if (existing !== base && !existing.startsWith(base + path.sep)) {
        throw invalidPath('Path escapes workspace');
      }
    }
    const abs = path.join(base, ...segments);
    await mkdir(abs, { recursive: true });
    return { rel, abs };
  }

  /**
   * Copies a file or folder into a folder of another workspace (symlinks left out), as
   * `name (n)` when the name is taken.
   */
  async copyInto(
    workspaceId: string,
    from: string,
    toWorkspaceId: string,
    toDir: string,
  ): Promise<FileEntry> {
    const source = await this.resolve(workspaceId, from, true);
    if (!source.rel) throw invalidPath('Cannot copy a whole workspace');
    if ((await lstat(source.abs)).isSymbolicLink()) throw invalidPath('Refusing to copy a symlink');
    const folder = await this.ensureFolder(toWorkspaceId, toDir);
    const name = await freeName(folder.abs, path.basename(source.abs));
    const abs = path.join(folder.abs, name);
    await cp(source.abs, abs, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (item) => !(await lstat(item)).isSymbolicLink(),
    });
    return (await this.entry(joinRel(folder.rel, name), abs)) as FileEntry;
  }

  /** Moves a file or folder to another workspace as `toDir/name` (numbered if taken). */
  async moveInto(
    workspaceId: string,
    from: string,
    toWorkspaceId: string,
    toDir: string,
    name: string,
  ): Promise<string> {
    const source = await this.resolve(workspaceId, from, true);
    if (!source.rel) throw invalidPath();
    const folder = await this.ensureFolder(toWorkspaceId, toDir);
    const free = await freeName(folder.abs, name);
    await rename(source.abs, path.join(folder.abs, free));
    return joinRel(folder.rel, free);
  }

  /** Writes (overwrites) a file, creating missing parent folders inside the workspace. */
  async writeFile(workspaceId: string, file: string, content: string | Buffer): Promise<FileEntry> {
    const rel = normalizePath(file);
    if (!rel) throw invalidPath();
    const folder = await this.ensureFolder(workspaceId, parentOf(rel));
    const abs = path.join(folder.abs, path.posix.basename(rel));
    if ((await lstat(abs).catch(() => null))?.isSymbolicLink())
      throw invalidPath('Refusing to write through a symlink');
    await writeFsFile(abs, content);
    return (await this.entry(rel, abs)) as FileEntry;
  }

  openRead(abs: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(abs, range);
  }

  /** Zips a folder (symlinks skipped) as a stream. */
  async zip(
    workspaceId: string,
    dir: string,
  ): Promise<{ name: string; stream: NodeJS.ReadableStream }> {
    const { rel, abs } = await this.resolve(workspaceId, dir, true);
    if (!(await stat(abs)).isDirectory()) throw invalidPath('Not a folder');
    const zip = new ZipFile();
    const walk = async (current: string, prefix: string): Promise<void> => {
      for (const name of await readdir(current)) {
        const child = path.join(current, name);
        const info = await lstat(child);
        const entryName = prefix ? `${prefix}/${name}` : name;
        if (info.isDirectory()) {
          zip.addEmptyDirectory(entryName, { mtime: info.mtime });
          await walk(child, entryName);
        } else if (info.isFile()) {
          zip.addFile(child, entryName, { mtime: info.mtime });
        }
      }
    };
    await walk(abs, '');
    zip.end();
    return { name: `${rel ? path.basename(abs) : 'workspace'}.zip`, stream: zip.outputStream };
  }
}
