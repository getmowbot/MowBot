import type { AttachmentUpload, Bot, Message } from '@mowbot/contract';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { messages } from '../src/db/schema';
import { bearer, createTestApp, multipartForm, setupOwner, TINY_PNG } from './helpers';
import { promptOf, scripted, textTurn } from './models';

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** What the model got as pictures at its n-th call: their types. */
function picturesShown(model: ReturnType<typeof scripted>, call: number): string[] {
  const prompt = model.doStreamCalls[call]?.prompt ?? [];
  return prompt.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'file' ? [part.mediaType] : []))
      : [],
  );
}

async function start() {
  const model = scripted([textTurn('Bien reçu.')]);
  t = await createTestApp({}, undefined, () => model);
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const chef = (
    (await app.inject({ method: 'GET', url: '/api/v1/bots', headers: auth })).json() as {
      items: Bot[];
    }
  ).items[0] as Bot;
  const upload = async (files: { name: string; content: Buffer | string; type?: string }[]) => {
    const form = multipartForm({}, files);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/attachments`,
      headers: { ...auth, ...form.headers },
      payload: form.payload,
    });
    return { status: res.statusCode, body: res.json() as AttachmentUpload };
  };
  const send = async (payload: object) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: auth,
      payload,
    });
    return { status: res.statusCode, body: res.json() as Message & { type?: string } };
  };
  return { app, services, auth, chef, model, upload, send };
}

describe('attachments', () => {
  it('are stored in the inbox and reach the bot: pictures as images, files by their path', async () => {
    const { services, chef, model, upload, send } = await start();
    const uploaded = await upload([
      { name: 'photo.png', content: TINY_PNG, type: 'image/png' },
      { name: 'courses.txt', content: 'lait\npain\nœufs' },
      { name: 'devis.pdf', content: Buffer.from('%PDF-1.4 binary\0stuff') },
    ]);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.items).toEqual([
      {
        workspaceId: chef.workspaceId,
        path: 'inbox/photo.png',
        name: 'photo.png',
        size: TINY_PNG.length,
        mimeType: 'image/png',
      },
      expect.objectContaining({ path: 'inbox/courses.txt', mimeType: 'text/plain' }),
      expect.objectContaining({ path: 'inbox/devis.pdf', mimeType: 'application/pdf' }),
    ]);
    // A second photo of the same name does not replace the first.
    const again = await upload([{ name: 'photo.png', content: TINY_PNG }]);
    expect(again.body.items[0]?.path).toBe('inbox/photo (1).png');

    const sent = await send({
      text: 'Regarde ça',
      attachments: uploaded.body.items.map((item) => ({ path: item.path })),
    });
    expect(sent.status).toBe(202);
    expect(sent.body.parts).toEqual([
      { type: 'text', text: 'Regarde ça' },
      ...uploaded.body.items.map((item) => ({ type: 'attachment', ...item })),
    ]);
    await services.runtime.settle();

    const prompt = promptOf(model, 0);
    expect(prompt).toContain('Regarde ça');
    expect(prompt).toContain('[Pièces jointes, rangées dans ton espace de travail]');
    expect(prompt).toContain("photo.png : l'image /workspace/inbox/photo.png");
    // A short text file comes whole, like an @ mention.
    expect(prompt).toContain('courses.txt : le fichier /workspace/inbox/courses.txt');
    expect(prompt).toContain('lait\\npain\\nœufs');
    expect(prompt).toContain('devis.pdf : le fichier /workspace/inbox/devis.pdf');
    expect(prompt).toContain('à ouvrir sur ton PC si besoin');
    expect(picturesShown(model, 0)).toEqual(['image/png']);

    // The picture is shown once: the next turn only names it, and nothing binary is stored.
    await send({ text: 'Et maintenant ?' });
    await services.runtime.settle();
    expect(picturesShown(model, 1)).toEqual([]);
    expect(promptOf(model, 1)).toContain('/workspace/inbox/photo.png');
    const [stored] = await services.db.select().from(messages).where(eq(messages.id, sent.body.id));
    expect(JSON.stringify(stored?.modelMessages)).not.toContain('iVBOR');
  });

  it('big photos reach the model scaled down to JPEG', async () => {
    const { services, model, upload, send } = await start();
    const photo = await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .png()
      .toBuffer();
    expect(photo.length).toBeGreaterThan(1024 ** 2);
    const uploaded = await upload([{ name: 'vacances.png', content: photo }]);
    await send({ text: '', attachments: [{ path: uploaded.body.items[0]?.path }] });
    await services.runtime.settle();
    expect(picturesShown(model, 0)).toEqual(['image/jpeg']);
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const image = prompt
      .flatMap((m) => (m.role === 'user' ? m.content : []))
      .find((part) => part.type === 'file');
    const file = image?.type === 'file' ? image.data : null;
    const data = file?.type === 'data' ? file.data : '';
    const meta = await sharp(
      typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data),
    ).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(1568);
  });

  it('a message may be only files, but not nothing; unknown files are refused', async () => {
    const { upload, send } = await start();
    const uploaded = await upload([{ name: 'plan.pdf', content: '%PDF' }]);
    const onlyFiles = await send({ attachments: [{ path: 'inbox/plan.pdf' }] });
    expect(onlyFiles.status).toBe(202);
    expect(onlyFiles.body.parts).toEqual([{ type: 'attachment', ...uploaded.body.items[0] }]);
    expect((await send({ text: '  ' })).status).toBe(400);
    const missing = await send({ text: 'Tiens', attachments: [{ path: 'inbox/nope.pdf' }] });
    expect(missing.status).toBe(400);
    expect(missing.body.type).toBe('urn:mowbot:problem:attachment_not_found');
    const folder = await send({ text: 'Tiens', attachments: [{ path: 'inbox' }] });
    expect(folder.body.type).toBe('urn:mowbot:problem:attachment_not_found');
  });
});
