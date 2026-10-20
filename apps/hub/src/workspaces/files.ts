import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type FileEntry, TRASH_FOLDER, WORKSPACE_FOLDERS } from '@mowbot/contract';
import { ZipFile } from 'yazl';
import { HttpProblem, notFound } from '../http/problems';

const invalidPath = (detail = 'Invalid path') => new HttpProblem(400, 'invalid_path', detail);
const alreadyExists = (detail = 'Path already exists') =>
  new HttpProblem(409, 'already_exists', detail);

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

/** Files of every workspace, stored under `<root>/<workspaceId>/`. */
export class WorkspaceFiles {
  constructor(readonly root: string) {}

  dirOf(workspaceId: string): string {
    return path.join(this.root, workspaceId);
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
