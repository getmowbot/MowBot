import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Bot, Message, MessagePart, ServerEvent } from '@mowbot/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePeaks, parseWav, peaksOf, voiceExtension } from '../src/voice/audio';
import type { Transcriber } from '../src/voice/whisper';
import { bearer, createTestApp, multipartForm, setupOwner } from './helpers';
import { promptOf, scripted, textTurn } from './models';

type AudioPart = Extract<MessagePart, { type: 'audio' }>;

/** One second of a 440 Hz tone, getting louder: 16-bit PCM WAV at 44.1 kHz, in stereo. */
function toneWav(seconds = 1, rate = 44_100): Buffer {
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 20_000 * (i / frames));
    data.writeInt16LE(value, i * 4);
    data.writeInt16LE(value, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A transcriber the test answers for, one recording at a time. */
function fakeTranscriber() {
  const calls: { samples: number; language: string }[] = [];
  const waiting: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const transcriber: Transcriber = {
    transcribe: (samples, language) => {
      calls.push({ samples: samples.length, language });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
  /** Resolves once the hub asked for a transcription (decoding comes first). */
  const next = async () => {
    for (let i = 0; i < 1_000 && waiting.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const job = waiting.shift();
    if (!job) throw new Error('No transcription asked');
    return job;
  };
  return { transcriber, calls, next };
}

let t: Awaited<ReturnType<typeof createTestApp>> | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(transcriber: Transcriber, turns = [textTurn("C'est noté !")]) {
  const model = scripted(turns);
  t = await createTestApp({}, undefined, () => model, { transcriber });
  const { app, services } = t;
  const auth = bearer((await setupOwner(app)).accessToken);
  const chef = (
    (await app.inject({ method: 'GET', url: '/api/v1/bots', headers: auth })).json() as {
      items: Bot[];
    }
  ).items[0] as Bot;
  const sendVoice = async (
    fields: Record<string, string>,
    file = { name: 'note.wav', content: toneWav(), type: 'audio/wav' },
  ) => {
    const form = multipartForm(fields, [file]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages/voice`,
      headers: { ...auth, ...form.headers },
      payload: form.payload,
    });
    return { status: res.statusCode, body: res.json() as Message };
  };
  const messages = async () =>
    (
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/bots/${chef.id}/messages`,
          headers: auth,
        })
      ).json() as { items: Message[] }
    ).items;
  return { app, services, auth, chef, model, sendVoice, messages };
}

const audioOf = (message: Message | undefined) =>
  message?.parts.find((p): p is AudioPart => p.type === 'audio');

describe('voice messages', () => {
  it('show at once, are transcribed on the hub, and the bot answers what was said', async () => {
    const voice = fakeTranscriber();
    const { services, chef, model, sendVoice, messages } = await start(voice.transcriber);
    const events: ServerEvent[] = [];
    services.events.subscribe((event) => events.push(event));

    const sent = await sendVoice({ durationMs: '980', peaks: '0.1,0.9,1.4' });
    expect(sent.status).toBe(202);
    const audio = audioOf(sent.body);
    expect(audio).toMatchObject({
      workspaceId: chef.workspaceId,
      mimeType: 'audio/wav',
      durationMs: 980,
      peaks: [0.1, 0.9, 1],
      transcript: null,
      transcriptStatus: 'pending',
    });
    expect(audio?.path).toMatch(/^inbox\/voice\/voice-\d{4}-\d{2}-\d{2}-\d{6}\.wav$/);
    const stored = await services.files.stat(chef.workspaceId as string, audio?.path ?? '');
    expect(stored.size).toBe(toneWav().length);

    // The bot waits for the words.
    const job = await voice.next();
    expect(model.doStreamCalls).toHaveLength(0);
    // Decoded to 16 kHz mono; heard in the owner's language.
    expect(voice.calls).toEqual([{ samples: 16_000, language: 'fr' }]);
    job.resolve('Rappelle-moi de sortir le chien à 18 h');
    await services.runtime.settle();

    const [message, answer] = await messages();
    expect(audioOf(message)).toMatchObject({
      transcript: 'Rappelle-moi de sortir le chien à 18 h',
      transcriptStatus: 'done',
      // The real length, once decoded.
      durationMs: 1000,
      peaks: [0.1, 0.9, 1],
    });
    expect(answer?.role).toBe('assistant');
    const prompt = promptOf(model, 0);
    expect(prompt).toContain('[Message vocal, transcrit automatiquement]');
    expect(prompt).toContain('Rappelle-moi de sortir le chien à 18 h');
    expect(
      events.some(
        (e) =>
          e.type === 'message.updated' &&
          audioOf(e.message)?.transcriptStatus === 'done' &&
          e.message.id === message?.id,
      ),
    ).toBe(true);
  });

  it('computes the waveform when the app sends none', async () => {
    const voice = fakeTranscriber();
    const { services, sendVoice, messages } = await start(voice.transcriber);
    const sent = await sendVoice({});
    expect(audioOf(sent.body)).toMatchObject({ peaks: [], durationMs: 0 });
    (await voice.next()).resolve('Salut');
    await services.runtime.settle();
    const peaks = audioOf((await messages())[0])?.peaks ?? [];
    expect(peaks).toHaveLength(64);
    // The tone gets louder: the waveform rises to its loudest bar.
    expect(peaks.at(-1)).toBe(1);
    expect(peaks[0]).toBeLessThan(peaks[40] ?? 0);
  });

  it('a failed transcription keeps the audio, wakes nobody, and can be tried again', async () => {
    const voice = fakeTranscriber();
    const { app, auth, services, chef, model, sendVoice, messages } = await start(
      voice.transcriber,
    );
    const sent = await sendVoice({ durationMs: '1000' });
    (await voice.next()).reject(new Error('model unavailable'));
    await services.runtime.settle();
    let [message] = await messages();
    expect(audioOf(message)?.transcriptStatus).toBe('failed');
    expect(model.doStreamCalls).toHaveLength(0);

    const retry = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages/${sent.body.id}/transcribe`,
      headers: auth,
    });
    expect(retry.statusCode).toBe(202);
    expect(audioOf(retry.json() as Message)?.transcriptStatus).toBe('pending');
    (await voice.next()).resolve('Tu peux réessayer ?');
    await services.runtime.settle();
    [message] = await messages();
    expect(audioOf(message)?.transcript).toBe('Tu peux réessayer ?');
    expect(promptOf(model, 0)).toContain('Tu peux réessayer ?');

    // Heard already: nothing to try again.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages/${sent.body.id}/transcribe`,
      headers: auth,
    });
    expect(again.statusCode).toBe(409);
  });

  it('a voice message tried again after the conversation went on moves to its end', async () => {
    const voice = fakeTranscriber();
    const { app, auth, services, chef, model, sendVoice, messages } = await start(
      voice.transcriber,
    );
    const sent = await sendVoice({});
    (await voice.next()).reject(new Error('boom'));
    await services.runtime.settle();
    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: auth,
      payload: { text: 'Bon, je te l’écris alors.' },
    });
    await services.runtime.settle();
    expect(model.doStreamCalls).toHaveLength(1);
    expect(promptOf(model, 0)).toContain("n'a pas pu lire : /workspace/inbox/voice/");

    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages/${sent.body.id}/transcribe`,
      headers: auth,
    });
    (await voice.next()).resolve('Et achète du pain');
    await services.runtime.settle();
    const list = await messages();
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(list[2]?.id).toBe(sent.body.id);
    expect(promptOf(model, 1)).toContain('Et achète du pain');
  });

  it('messages written while a voice message is transcribed wait for its words', async () => {
    const voice = fakeTranscriber();
    const { app, auth, services, chef, model, sendVoice } = await start(voice.transcriber);
    await sendVoice({});
    const job = await voice.next();
    await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages`,
      headers: auth,
      payload: { text: 'Et les poubelles aussi' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(model.doStreamCalls).toHaveLength(0);
    job.resolve('Sors le chien');
    await services.runtime.settle();
    // One answer, to both, in the order they were sent.
    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = promptOf(model, 0);
    expect(prompt.indexOf('Sors le chien')).toBeLessThan(prompt.indexOf('Et les poubelles'));
  });

  it('nothing heard: the bot is not woken up', async () => {
    const voice = fakeTranscriber();
    const { services, model, sendVoice, messages } = await start(voice.transcriber);
    await sendVoice({});
    (await voice.next()).resolve('');
    await services.runtime.settle();
    const [message] = await messages();
    expect(audioOf(message)).toMatchObject({ transcript: '', transcriptStatus: 'done' });
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('refuses what is not a recording', async () => {
    const voice = fakeTranscriber();
    const { app, auth, chef, sendVoice } = await start(voice.transcriber);
    const notAudio = await sendVoice(
      {},
      { name: 'notes.txt', content: toneWav(), type: 'text/plain' },
    );
    expect(notAudio.status).toBe(415);
    const form = multipartForm({ durationMs: '100' }, []);
    const empty = await app.inject({
      method: 'POST',
      url: `/api/v1/bots/${chef.id}/messages/voice`,
      headers: { ...auth, ...form.headers },
      payload: form.payload,
    });
    expect(empty.statusCode).toBe(400);
  });

  const ffmpeg = (() => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!ffmpeg)('converts recordings some players cannot read to AAC', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mowbot-voice-'));
    try {
      await writeFile(path.join(dir, 'in.wav'), toneWav(2));
      execFileSync('ffmpeg', ['-v', 'error', '-i', 'in.wav', '-c:a', 'libopus', 'out.webm'], {
        cwd: dir,
      });
      const webm = await readFile(path.join(dir, 'out.webm'));
      const voice = fakeTranscriber();
      const { services, chef, sendVoice, messages } = await start(voice.transcriber);
      const sent = await sendVoice(
        {},
        { name: 'blob', content: webm, type: 'audio/webm;codecs=opus' },
      );
      const original = audioOf(sent.body)?.path ?? '';
      expect(original).toMatch(/\.webm$/);
      (await voice.next()).resolve('Bonjour');
      await services.runtime.settle();
      const audio = audioOf((await messages())[0]);
      expect(audio).toMatchObject({ mimeType: 'audio/mp4', transcriptStatus: 'done' });
      expect(audio?.path).toBe(original.replace(/\.webm$/, '.m4a'));
      expect(Math.abs((audio?.durationMs ?? 0) - 2000)).toBeLessThan(100);
      expect(voice.calls[0]?.samples).toBeGreaterThan(31_000);
      const workspace = services.files.dirOf(chef.workspaceId as string);
      await expect(stat(path.join(workspace, original))).rejects.toThrow();
      expect((await stat(path.join(workspace, audio?.path ?? ''))).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('audio helpers', () => {
  it('reads WAV files to 16 kHz mono', () => {
    const samples = parseWav(toneWav(0.5, 48_000));
    expect(samples).toHaveLength(8_000);
    expect(parseWav(Buffer.from('not a wav file at all, really not one'))).toBeNull();
  });

  it('draws waveforms within 0–1, the loudest bar at 1', () => {
    const samples = new Float32Array(1_000).map((_, i) => (i < 500 ? 0.1 : 0.4));
    const peaks = peaksOf(samples, 4);
    expect(peaks).toEqual([0.5, 0.5, 1, 1]);
    expect(peaksOf(new Float32Array(0))).toEqual([]);
    expect(peaksOf(new Float32Array(10))).toEqual(new Array(10).fill(0));
  });

  it('takes the waveform an app sends, within bounds', () => {
    expect(parsePeaks('0,0.456,2,-1')).toEqual([0, 0.46, 1, 0]);
    expect(parsePeaks('0.1,nope')).toBeNull();
    expect(parsePeaks(undefined)).toBeNull();
    expect(parsePeaks(Array(500).fill('0.5').join(','))).toHaveLength(200);
  });

  it('knows a recording by its type or its name', () => {
    expect(voiceExtension('audio/webm;codecs=opus', 'blob')).toBe('.webm');
    expect(voiceExtension('audio/mp4', 'x')).toBe('.m4a');
    expect(voiceExtension('application/octet-stream', 'recording.m4a')).toBe('.m4a');
    expect(voiceExtension('text/plain', 'notes.txt')).toBeNull();
  });
});
