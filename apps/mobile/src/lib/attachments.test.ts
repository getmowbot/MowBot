import type { MessagePart } from '@mowbot/contract';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  addAttachments,
  canSend,
  fromDocument,
  fromMedia,
  isShownPicture,
  MAX_ATTACHMENTS,
  type PendingAttachment,
  userMedia,
} from './attachments';

const at = new Date(2026, 9, 21, 14, 32, 5);

const pending = (id: string, size: number | null = 10): PendingAttachment => ({
  id,
  uri: `file:///${id}`,
  name: `${id}.txt`,
  size,
  mimeType: 'text/plain',
  image: false,
});

describe('picked files', () => {
  it('takes a document as it comes, its type guessed from its name when missing', () => {
    expect(
      fromDocument({ uri: 'file:///a', name: 'Devis.PDF', size: 1200, mimeType: null }, '1'),
    ).toEqual({
      id: '1',
      uri: 'file:///a',
      name: 'Devis.PDF',
      size: 1200,
      mimeType: 'application/pdf',
      image: false,
    });
    expect(fromDocument({ uri: 'file:///b', name: 'plan.png' }, '2')).toMatchObject({
      size: null,
      mimeType: 'image/png',
      image: true,
    });
  });

  it('names camera shots and videos after the time they were taken', () => {
    expect(fromMedia({ uri: 'file:///c', mimeType: 'image/jpeg' }, '3', at)).toMatchObject({
      name: 'photo-2026-10-21-143205.jpg',
      mimeType: 'image/jpeg',
      image: true,
    });
    expect(fromMedia({ uri: 'file:///d', type: 'video' }, '4', at)).toMatchObject({
      name: 'video-2026-10-21-143205.mp4',
      mimeType: 'video/mp4',
      image: false,
    });
    expect(
      fromMedia(
        { uri: 'file:///e', fileName: 'IMG_0042.HEIC', mimeType: 'image/heic', fileSize: 5 },
        '5',
        at,
      ),
    ).toMatchObject({ name: 'IMG_0042.HEIC', size: 5, image: false });
  });

  it('keeps to the size limit and to the number of files a message takes', () => {
    const big = pending('big', ATTACHMENT_MAX_BYTES + 1);
    const first = addAttachments([], [pending('a'), big, pending('b')]);
    expect(first.list.map((f) => f.id)).toEqual(['a', 'b']);
    expect(first.tooBig?.id).toBe('big');
    expect(first.overflow).toBe(0);

    const full = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => pending(`f${i}`));
    const more = addAttachments(full, [pending('x'), pending('y'), pending('z')]);
    expect(more.list).toHaveLength(MAX_ATTACHMENTS);
    expect(more.list.at(-1)?.id).toBe('x');
    expect(more.overflow).toBe(2);
    expect(more.tooBig).toBeNull();
  });

  it('sends words, files, or both', () => {
    expect(canSend('  ', [])).toBe(false);
    expect(canSend('Salut', [])).toBe(true);
    expect(canSend('', [pending('a')])).toBe(true);
  });
});

describe('a sent message', () => {
  const attachment = (name: string, mimeType: string) =>
    ({
      type: 'attachment',
      workspaceId: '00000000-0000-4000-8000-000000000000',
      path: `inbox/${name}`,
      name,
      size: 10,
      mimeType,
    }) as const;

  it('tells pictures from files, and finds its voice message', () => {
    const voice: MessagePart = {
      type: 'audio',
      workspaceId: '00000000-0000-4000-8000-000000000000',
      path: 'inbox/voice/voice-1.m4a',
      mimeType: 'audio/mp4',
      durationMs: 1000,
      peaks: [0.5],
      transcript: null,
      transcriptStatus: 'pending',
    };
    const parts: MessagePart[] = [
      { type: 'text', text: 'Regarde' },
      attachment('photo.jpg', 'image/jpeg'),
      attachment('IMG_1.heic', 'image/heic'),
      attachment('devis.pdf', 'application/pdf'),
      voice,
    ];
    const media = userMedia(parts);
    expect(media.pictures.map((p) => p.name)).toEqual(['photo.jpg']);
    expect(media.files.map((p) => p.name)).toEqual(['IMG_1.heic', 'devis.pdf']);
    expect(media.voice).toBe(voice);
    expect(userMedia([{ type: 'text', text: 'Salut' }])).toEqual({
      pictures: [],
      files: [],
      voice: null,
    });
    expect(isShownPicture({ name: 'x.svg', mimeType: 'image/svg+xml' })).toBe(true);
  });
});
