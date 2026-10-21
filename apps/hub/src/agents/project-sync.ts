import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { BotRow } from '../bots/service';
import type { ConnectorService, ProjectRow } from '../connectors/service';
import type { WorkspaceFiles } from '../workspaces/files';

/** Where the copy of each project lives in the team's workspace (`/workspace/projects/…`). */
export function projectFolder(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `projects/${slug || 'projet'}`;
}

/** What was copied last time: each file's hash and the commit the copy started from. */
interface SyncState {
  projectId: string;
  head: string | null;
  files: Record<string, string>;
  at: string;
}

const STATE_FILE = '.mowbot-sync.json';
/** One `read_files` answer stays under this (base64 makes it a third bigger). */
const BATCH_BYTES = 6 * 1024 * 1024;
const BATCH_FILES = 200;
/** What a branch may carry at most. */
const PUSH_BYTES = 40 * 1024 * 1024;
/** Never brought back, even without a .gitignore saying so. */
const ALWAYS_IGNORED = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'target/',
  '.next/',
  '.turbo/',
  '.cache/',
  STATE_FILE,
];

interface Manifest {
  files: { path: string; size: number; hash: string }[];
  head: string | null;
  truncated: boolean;
}

interface Ctx {
  bot: BotRow;
  files: WorkspaceFiles;
  connectors: ConnectorService;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
const within = (rel: string, sub: string) => !sub || rel === sub || rel.startsWith(`${sub}/`);

async function readState(ctx: Ctx, workspaceId: string, dir: string): Promise<SyncState | null> {
  const found = await ctx.files.readText(workspaceId, `${dir}/${STATE_FILE}`).catch(() => null);
  if (!found) return null;
  try {
    return JSON.parse(found.text) as SyncState;
  } catch {
    return null;
  }
}

/** The copy's files (path → absolute path), without what git would ignore. */
async function walkCopy(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await walkWithOwners(root, '', [ignore().add(ALWAYS_IGNORED)], new Map(), found);
  return found;
}

async function walkWithOwners(
  dir: string,
  rel: string,
  rules: Ignore[],
  owners: Map<Ignore, string>,
  found: Map<string, string>,
): Promise<void> {
  let here = rules;
  const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8').catch(() => null);
  if (gitignore !== null) {
    const rule = ignore().add(gitignore);
    owners.set(rule, rel);
    here = [...rules, rule];
  }
  for (const name of await readdir(dir)) {
    const childRel = rel ? `${rel}/${name}` : name;
    const abs = path.join(dir, name);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) continue;
    const directory = info.isDirectory();
    const ignored = here.some((rule) => {
      // Each .gitignore applies relative to its own folder.
      const owner = owners.get(rule) ?? '';
      const local = owner ? childRel.slice(owner.length + 1) : childRel;
      return rule.ignores(directory ? `${local}/` : local);
    });
    if (ignored) continue;
    if (directory) await walkWithOwners(abs, childRel, here, owners, found);
    else if (info.isFile()) found.set(childRel, abs);
  }
}

/**
 * Copies a project (or one of its folders) from the user's computer into the team's
 * workspace: only what changed since the last copy travels. A file the bot changed in its copy
 * is kept (and reported) rather than overwritten.
 */
export async function pullProject(ctx: Ctx, project: ProjectRow, sub = ''): Promise<string> {
  const { bot, files, connectors } = ctx;
  if (!bot.workspaceId) throw new Error("Tu n'as pas de workspace où copier le projet.");
  const workspaceId = bot.workspaceId;
  const dir = projectFolder(project.name);
  const manifest = await connectors.request<Manifest>(
    project,
    'manifest',
    sub ? { path: sub } : {},
    180_000,
  );
  const state: SyncState = (await readState(ctx, workspaceId, dir)) ?? {
    projectId: project.id,
    head: null,
    files: {},
    at: '',
  };
  const localHash = async (rel: string) => {
    const found = await files.stat(workspaceId, `${dir}/${rel}`).catch(() => null);
    if (found?.type !== 'file') return null;
    return sha256(await readFile(found.abs));
  };

  const wanted: Manifest['files'] = [];
  const kept: string[] = [];
  let unchanged = 0;
  for (const file of manifest.files) {
    const local = await localHash(file.path);
    if (local === file.hash) {
      unchanged += 1;
      continue;
    }
    // Changed in the copy since the last pull: the bot's work wins, the user's change waits.
    if (local !== null && state.files[file.path] && local !== state.files[file.path]) {
      kept.push(file.path);
      continue;
    }
    wanted.push(file);
  }

  let copied = 0;
  let bytes = 0;
  for (let i = 0; i < wanted.length; ) {
    const batch: string[] = [];
    let size = 0;
    while (i < wanted.length && batch.length < BATCH_FILES) {
      const next = wanted[i] as Manifest['files'][number];
      if (batch.length > 0 && size + next.size > BATCH_BYTES) break;
      batch.push(next.path);
      size += next.size;
      i += 1;
    }
    const { files: got } = await connectors.request<{ files: { path: string; data: string }[] }>(
      project,
      'read_files',
      { paths: batch },
      180_000,
    );
    for (const file of got) {
      const content = Buffer.from(file.data, 'base64');
      await files.writeFile(workspaceId, `${dir}/${file.path}`, content);
      copied += 1;
      bytes += content.length;
    }
  }

  // Gone on the user's side (and untouched in the copy): gone here too.
  const present = new Set(manifest.files.map((f) => f.path));
  let removed = 0;
  for (const [rel, hash] of Object.entries(state.files)) {
    if (!within(rel, sub) || present.has(rel)) continue;
    if ((await localHash(rel)) === hash) {
      await files.unlink(workspaceId, `${dir}/${rel}`);
      removed += 1;
    }
    delete state.files[rel];
  }

  for (const file of manifest.files) {
    if (!kept.includes(file.path)) state.files[file.path] = file.hash;
  }
  state.projectId = project.id;
  state.head = manifest.head;
  state.at = new Date().toISOString();
  await files.writeFile(workspaceId, `${dir}/${STATE_FILE}`, JSON.stringify(state, null, 1));

  const where = `/workspace/${dir}${sub ? `/${sub}` : ''}`;
  return [
    `Copié dans ${where} : ${copied} fichier${copied > 1 ? 's' : ''} (${mb(bytes)}), ${unchanged} inchangé${unchanged > 1 ? 's' : ''}${removed ? `, ${removed} retiré${removed > 1 ? 's' : ''}` : ''}.`,
    kept.length
      ? `Gardés tels que tu les as modifiés (l'utilisateur les a aussi changés de son côté) : ${kept.slice(0, 20).join(', ')}.`
      : '',
    manifest.truncated
      ? 'Projet très gros : une partie seulement est copiée (fichiers de plus de 20 Mo laissés de côté).'
      : '',
    manifest.head
      ? `Dépôt git (commit ${manifest.head.slice(0, 8)}) : rapporte tes changements avec local_push, ils arriveront dans une branche.`
      : 'Pas de dépôt git : local_push écrira tes changements directement dans son dossier.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Brings the copy's changes back as a branch of the user's repository, started from the commit
 * the copy came from: the user's folder is not touched. Not a repository: written into it.
 */
export async function pushProject(ctx: Ctx, project: ProjectRow, message: string): Promise<string> {
  const { bot, files, connectors } = ctx;
  if (!bot.workspaceId) throw new Error("Tu n'as pas de workspace.");
  const workspaceId = bot.workspaceId;
  const dir = projectFolder(project.name);
  const state = await readState(ctx, workspaceId, dir);
  if (!state || state.projectId !== project.id) {
    throw new Error(`Aucune copie de « ${project.name} » : fais d'abord local_pull.`);
  }
  const root = (await files.stat(workspaceId, dir)).abs;
  const copy = await walkCopy(root);
  if (!state.head) return writeBack(ctx, project, { workspaceId, dir, state, copy });
  const changed: { path: string; data: string }[] = [];
  let added = 0;
  let modified = 0;
  let bytes = 0;
  for (const [rel, abs] of copy) {
    const content = await readFile(abs);
    const before = state.files[rel];
    if (before === sha256(content)) continue;
    if (before) modified += 1;
    else added += 1;
    bytes += content.length;
    if (bytes > PUSH_BYTES) {
      throw new Error(
        `Trop de changements pour une branche (plus de ${mb(PUSH_BYTES)}) : vérifie que des fichiers générés ne sont pas pris (.gitignore).`,
      );
    }
    changed.push({ path: rel, data: content.toString('base64') });
  }
  const deletes = Object.keys(state.files).filter((rel) => !copy.has(rel));
  if (changed.length === 0 && deletes.length === 0) return 'Aucun changement à rapporter.';

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const name = `mowbot/${projectFolder(bot.name).slice('projects/'.length)}-${stamp}`;
  const author = { name: `${bot.name} (MowBot)`, email: 'bots@mowbot.local' };
  let result: { branch: string; commit: string } | null = null;
  for (let attempt = 0; attempt < 5 && !result; attempt++) {
    const branch = attempt === 0 ? name : `${name}-${attempt + 1}`;
    try {
      result = await connectors.request<{ branch: string; commit: string }>(
        project,
        'branch',
        { name: branch, message, author, base: state.head, files: changed, deletes },
        180_000,
      );
    } catch (error) {
      if (!/existe déjà/.test((error as Error).message)) throw error;
    }
  }
  if (!result) throw new Error('Impossible de trouver un nom de branche libre.');
  return [
    `Branche ${result.branch} créée dans « ${project.name} » (commit ${result.commit.slice(0, 8)}, partie de ${state.head.slice(0, 8)}) : ${modified} modifié${modified > 1 ? 's' : ''}, ${added} ajouté${added > 1 ? 's' : ''}, ${deletes.length} supprimé${deletes.length > 1 ? 's' : ''}.`,
    "Son dossier n'a pas bougé : dis-lui qu'il peut relire la branche et la fusionner (git diff, git merge).",
  ].join('\n');
}

/** The desktop app writes binary files (sent in base64) from this version on. */
const BINARY_WRITES_FROM = [0, 2, 4];

function atLeast(version: string | null | undefined, wanted: number[]): boolean {
  const parts = (version ?? '').split(/[.-]/).map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < wanted.length; i++) {
    const have = parts[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== wanted[i]) return have > (wanted[i] as number);
  }
  return true;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The file as text, or null when it is binary. */
function asText(content: Buffer): string | null {
  if (content.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(content);
  } catch {
    return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/**
 * A folder that is not a git repository: the copy's changes are written straight into it. A
 * file the user changed (or created) since the copy is left as it is and reported; files gone
 * from the copy are not deleted on their side.
 */
async function writeBack(
  ctx: Ctx,
  project: ProjectRow,
  {
    workspaceId,
    dir,
    state,
    copy,
  }: {
    workspaceId: string;
    dir: string;
    state: SyncState;
    copy: Map<string, string>;
  },
): Promise<string> {
  const { files, connectors } = ctx;
  const manifest = await connectors.request<Manifest>(project, 'manifest', {}, 180_000);
  const theirs = new Map(manifest.files.map((file) => [file.path, file.hash]));
  const machine = (await connectors.connectorsOf([project])).get(project.connectorId);
  const binaries = atLeast(machine?.version, BINARY_WRITES_FROM);

  const conflicts: string[] = [];
  const skipped: string[] = [];
  let added = 0;
  let modified = 0;
  let bytes = 0;
  for (const [rel, abs] of copy) {
    const content = await readFile(abs);
    const hash = sha256(content);
    const before = state.files[rel];
    if (before === hash) continue;
    const there = theirs.get(rel);
    if (there === hash) {
      state.files[rel] = hash;
      continue;
    }
    // Changed on the user's side since the copy: their version stays.
    if (there !== undefined && there !== before) {
      conflicts.push(rel);
      continue;
    }
    const text = asText(content);
    if (text === null && !binaries) {
      skipped.push(rel);
      continue;
    }
    bytes += content.length;
    if (bytes > PUSH_BYTES) {
      throw new Error(
        `Trop de changements d'un coup (plus de ${mb(PUSH_BYTES)}) : vérifie que des fichiers générés ne sont pas pris (.gitignore).`,
      );
    }
    await connectors.request(
      project,
      'write',
      text === null
        ? { path: rel, content: content.toString('base64'), base64: true }
        : { path: rel, content: text },
      60_000,
    );
    state.files[rel] = hash;
    if (there === undefined) added += 1;
    else modified += 1;
  }
  const gone = Object.keys(state.files).filter((rel) => !copy.has(rel) && theirs.has(rel));
  state.at = new Date().toISOString();
  await files.writeFile(workspaceId, `${dir}/${STATE_FILE}`, JSON.stringify(state, null, 1));

  if (added + modified === 0 && conflicts.length + skipped.length + gone.length === 0) {
    return 'Aucun changement à rapporter.';
  }
  return [
    `Écrit dans le dossier de l'utilisateur (« ${project.name} », pas un dépôt git) : ${plural(modified, 'modifié')}, ${plural(added, 'ajouté')}.`,
    conflicts.length
      ? `Laissés tels quels, l'utilisateur les a changés depuis ta copie : ${conflicts.slice(0, 20).join(', ')}. Refais local_pull, reporte tes changements dessus, puis local_push.`
      : '',
    skipped.length
      ? `Pas copiés, fichiers binaires (son app MowBot desktop doit être mise à jour) : ${skipped.slice(0, 20).join(', ')}.`
      : '',
    gone.length
      ? `Supprimés dans ta copie mais pas chez lui (local_push ne supprime rien) : ${gone.slice(0, 20).join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
