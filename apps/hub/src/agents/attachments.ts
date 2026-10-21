import { readFile } from 'node:fs/promises';
import type { MessageAttachment, MessagePart } from '@mowbot/contract';
import type { FilePart } from 'ai';
import type { BotRow } from '../bots/service';
import { contentTypeFor } from '../http/content-types';
import { HttpProblem } from '../http/problems';
import type { WorkspaceFiles } from '../workspaces/files';
import { describeFile, size } from './mentions';

/** Where the files the user sends a bot are put, in its workspace. */
export const INBOX = 'inbox';

/** Pictures every model reads as they are. */
const MODEL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Smaller pictures of those types go to the model untouched. */
const RAW_IMAGE_MAX_BYTES = 1024 ** 2;
/** Larger pictures are not worth decoding. */
const IMAGE_MAX_BYTES = 40 * 1024 ** 2;
/** Longest side of a picture shown to a model (what providers scale down to anyway). */
const IMAGE_MAX_SIDE = 1568;

type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;

/** The type of a stored file, from its name (no charset). */
export const mimeTypeOf = (name: string) => contentTypeFor(name).split(';')[0] ?? '';

export const isPicture = (mimeType: string) =>
  mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';

/** A stored file, as a message shows it. */
export function toAttachment(
  workspaceId: string,
  entry: { path: string; name: string; size: number },
): MessageAttachment {
  return {
    workspaceId,
    path: entry.path,
    name: entry.name,
    size: entry.size,
    mimeType: mimeTypeOf(entry.name),
  };
}

/**
 * Files sent with a message: the parts the apps show, and what the bot reads of them (where they
 * are on its PC, short text files whole; pictures come along as images).
 */
export async function resolveAttachments(
  files: WorkspaceFiles,
  bot: BotRow,
  refs: { path: string }[],
): Promise<{ parts: AttachmentPart[]; context: string }> {
  if (refs.length === 0) return { parts: [], context: '' };
  const workspaceId = bot.workspaceId;
  if (!workspaceId) throw new HttpProblem(409, 'no_workspace', 'This bot has no workspace');
  const parts: AttachmentPart[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const entry = await files.stat(workspaceId, ref.path).catch(() => null);
    if (entry?.type !== 'file') {
      throw new HttpProblem(400, 'attachment_not_found', `No file at ${ref.path}`);
    }
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const attachment = toAttachment(workspaceId, entry);
    parts.push({ type: 'attachment', ...attachment });
    if (isPicture(attachment.mimeType)) {
      lines.push(
        `- ${entry.name} : l'image /workspace/${entry.path} (${size(entry.size)}), jointe ci-dessous.`,
      );
      continue;
    }
    const line = await describeFile(files, bot, entry.path, entry.name);
    if (line) lines.push(line.text);
  }
  return {
    parts,
    context: `[Pièces jointes, rangées dans ton espace de travail]\n${lines.join('\n')}`,
  };
}

/** A picture as a model takes it: small ones as they are, the others scaled down to JPEG. */
async function pictureForModel(abs: string, bytes: number, mimeType: string) {
  if (bytes <= RAW_IMAGE_MAX_BYTES && MODEL_IMAGE_TYPES.has(mimeType)) {
    return { data: await readFile(abs), mediaType: mimeType };
  }
  if (bytes > IMAGE_MAX_BYTES) return null;
  try {
    // Loaded on demand: most messages carry no picture.
    const { default: sharp } = await import('sharp');
    const data = await sharp(abs)
      .rotate()
      .resize({
        width: IMAGE_MAX_SIDE,
        height: IMAGE_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer();
    return { data, mediaType: 'image/jpeg' };
  } catch {
    // A format it cannot read (HEIC…): the bot has the path.
    return null;
  }
}

/** The pictures attached to a message, for the model; those gone or unreadable are left out. */
export async function picturesOf(files: WorkspaceFiles, parts: MessagePart[]): Promise<FilePart[]> {
  const out: FilePart[] = [];
  for (const part of parts) {
    if (part.type !== 'attachment' || !isPicture(part.mimeType)) continue;
    const entry = await files.stat(part.workspaceId, part.path).catch(() => null);
    if (entry?.type !== 'file') continue;
    const picture = await pictureForModel(entry.abs, entry.size, part.mimeType).catch(() => null);
    if (picture) out.push({ type: 'file', ...picture });
  }
  return out;
}
