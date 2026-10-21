import { MAX_ATTACHMENTS, type MessageAttachment, type MessagePart } from '@mowbot/contract';
import { fileKind, mimeTypeFor } from './files';

/**
 * Files and pictures sent with a message: what the pickers give, made into the strip shown
 * before sending; how a sent message's files are shown. No React, no native modules: unit tested.
 */

export { MAX_ATTACHMENTS };

/** The hub takes files up to this size in a conversation. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 ** 2;

/** A file picked for the next message. */
export interface PendingAttachment {
  /** Tells two picks of the same file apart (the strip's keys). */
  id: string;
  /** Local file (`file://…`, `content://…`). */
  uri: string;
  name: string;
  /** Unknown for some documents. */
  size: number | null;
  mimeType: string;
  /** Shown as a thumbnail in the strip. */
  image: boolean;
}

/** `2026-10-21-143205`, local time. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const extensionFor = (mimeType: string, video: boolean) => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/heic') return 'heic';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  if (video) return mimeType === 'video/quicktime' ? 'mov' : 'mp4';
  return 'jpg';
};

/** A document from the document picker. */
export function fromDocument(
  asset: { uri: string; name: string; size?: number | null; mimeType?: string | null },
  id: string,
): PendingAttachment {
  const mimeType = asset.mimeType || mimeTypeFor(asset.name);
  return {
    id,
    uri: asset.uri,
    name: asset.name,
    size: asset.size ?? null,
    mimeType,
    image: fileKind(asset.name) === 'image',
  };
}

/**
 * A photo or a video from the library or the camera: the camera gives no name, the library not
 * always; one is made from the time it was picked.
 */
export function fromMedia(
  asset: {
    uri: string;
    fileName?: string | null;
    fileSize?: number | null;
    mimeType?: string | null;
    type?: string | null;
  },
  id: string,
  now: Date,
): PendingAttachment {
  const video = asset.type === 'video' || Boolean(asset.mimeType?.startsWith('video/'));
  const mimeType = asset.mimeType || (video ? 'video/mp4' : 'image/jpeg');
  const name =
    asset.fileName?.trim() ||
    `${video ? 'video' : 'photo'}-${stamp(now)}.${extensionFor(mimeType, video)}`;
  return {
    id,
    uri: asset.uri,
    name,
    size: asset.fileSize ?? null,
    mimeType,
    image: !video && fileKind(name) === 'image',
  };
}

/**
 * Files added to the strip: those over the size limit are left out, and no more than the
 * message takes. Says what was left out, for a notice.
 */
export function addAttachments(
  current: readonly PendingAttachment[],
  added: readonly PendingAttachment[],
): { list: PendingAttachment[]; tooBig: PendingAttachment | null; overflow: number } {
  const tooBig = added.find((file) => (file.size ?? 0) > ATTACHMENT_MAX_BYTES) ?? null;
  const fitting = added.filter((file) => (file.size ?? 0) <= ATTACHMENT_MAX_BYTES);
  const room = Math.max(0, MAX_ATTACHMENTS - current.length);
  return {
    list: [...current, ...fitting.slice(0, room)],
    tooBig,
    overflow: Math.max(0, fitting.length - room),
  };
}

/** Something to send: words, or files. */
export function canSend(text: string, attachments: readonly PendingAttachment[]): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

/** Pictures a phone shows (a HEIC photo shows as a file elsewhere: kept as one here too). */
export function isShownPicture(attachment: Pick<MessageAttachment, 'name' | 'mimeType'>): boolean {
  return attachment.mimeType.startsWith('image/') && fileKind(attachment.name) === 'image';
}

type AttachmentPart = Extract<MessagePart, { type: 'attachment' }>;
type AudioPart = Extract<MessagePart, { type: 'audio' }>;

/** What a message the user sent carries besides its text: pictures, files, a voice message. */
export function userMedia(parts: readonly MessagePart[]): {
  pictures: AttachmentPart[];
  files: AttachmentPart[];
  voice: AudioPart | null;
} {
  const attachments = parts.filter((p): p is AttachmentPart => p.type === 'attachment');
  return {
    pictures: attachments.filter(isShownPicture),
    files: attachments.filter((a) => !isShownPicture(a)),
    voice: parts.find((p): p is AudioPart => p.type === 'audio') ?? null,
  };
}
