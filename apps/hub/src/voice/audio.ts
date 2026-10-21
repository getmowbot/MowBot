import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MAX_PEAKS } from '@mowbot/contract';
import { contentTypeFor } from '../http/content-types';

/** Whisper listens at 16 kHz, in mono. */
export const SAMPLE_RATE = 16_000;
/** Bars of a waveform computed on the hub (the apps fit them to their width). */
export const PEAK_BARS = 64;
/** A recording is decoded in less than this, or given up. */
const FFMPEG_TIMEOUT_MS = 3 * 60_000;

/** File extension of a recording, from its type or its name; null: not a recording. */
const VOICE_TYPES: Record<string, string> = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/3gpp': '.3gp',
  'audio/x-caf': '.caf',
};
const VOICE_EXTENSIONS = new Set([...Object.values(VOICE_TYPES), '.weba', '.oga', '.mp4']);
/** Played as they are by browsers, iOS and Android; other recordings are converted to AAC. */
const PLAYABLE_EVERYWHERE = new Set(['.m4a', '.mp4', '.aac', '.mp3', '.wav']);

export function voiceExtension(mimeType: string, fileName: string): string | null {
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const byType = VOICE_TYPES[type];
  if (byType) return byType;
  const ext = path.extname(fileName).toLowerCase();
  return VOICE_EXTENSIONS.has(ext) ? ext : null;
}

export const playableEverywhere = (fileName: string) =>
  PLAYABLE_EVERYWHERE.has(path.extname(fileName).toLowerCase());

/** Containers that also hold video, named for their audio here. */
const AUDIO_TYPES: Record<string, string> = {
  '.webm': 'audio/webm',
  '.mp4': 'audio/mp4',
  '.3gp': 'audio/3gpp',
  '.caf': 'audio/x-caf',
};

/** The type of a stored recording, from its name. */
export function audioTypeOf(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return AUDIO_TYPES[ext] ?? contentTypeFor(fileName).split(';')[0] ?? 'application/octet-stream';
}

/** Waveform bars sent by a client (`0.1,0.53,…`), kept within 0–1; null when unusable. */
export function parsePeaks(field: string | undefined): number[] | null {
  if (!field) return null;
  const values = field
    .split(',')
    .slice(0, MAX_PEAKS)
    .map((value) => Number(value));
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;
  return values.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100);
}

/**
 * Loudness along a recording, 0–1, the loudest bar at 1: the RMS of each slice, lifted by a
 * square root so speech that is soft still shows.
 */
export function peaksOf(samples: Float32Array, bars = PEAK_BARS): number[] {
  if (samples.length === 0) return [];
  const count = Math.min(bars, samples.length);
  const rms: number[] = [];
  for (let bar = 0; bar < count; bar++) {
    const start = Math.floor((bar * samples.length) / count);
    const end = Math.floor(((bar + 1) * samples.length) / count);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i] ?? 0) ** 2;
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const loudest = Math.max(...rms);
  if (loudest === 0) return rms.map(() => 0);
  return rms.map((value) => Math.round(Math.sqrt(value / loudest) * 100) / 100);
}

/** Mono, at 16 kHz (linear interpolation: enough for speech recognition). */
function toMono16k(channels: Float32Array[], rate: number): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const mono = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  if (rate === SAMPLE_RATE) return mono;
  const out = new Float32Array(Math.floor((frames * SAMPLE_RATE) / rate));
  const step = rate / SAMPLE_RATE;
  for (let i = 0; i < out.length; i++) {
    const at = i * step;
    const before = Math.floor(at);
    const weight = at - before;
    out[i] = (mono[before] ?? 0) * (1 - weight) + (mono[before + 1] ?? mono[before] ?? 0) * weight;
  }
  return out;
}

/**
 * Samples of a PCM WAV file (16-bit or 32-bit float), at 16 kHz mono; null for anything else.
 * Spares ffmpeg for the format it would only copy.
 */
export function parseWav(buffer: Buffer): Float32Array | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      format = {
        code: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data' && format) {
      const { code, channels, rate, bits } = format;
      const pcm16 = (code === 1 || code === 0xfffe) && bits === 16;
      const float32 = (code === 3 || code === 0xfffe) && bits === 32;
      if (channels < 1 || rate < 1000 || (!pcm16 && !float32)) return null;
      const bytes = bits / 8;
      const end = Math.min(buffer.length, body + size);
      const frames = Math.floor((end - body) / (bytes * channels));
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let frame = 0; frame < frames; frame++) {
        for (let c = 0; c < channels; c++) {
          const at = body + (frame * channels + c) * bytes;
          (data[c] as Float32Array)[frame] = pcm16
            ? buffer.readInt16LE(at) / 32_768
            : buffer.readFloatLE(at);
        }
      }
      return toMono16k(data, rate);
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * Decodes a recording with ffmpeg to 16 kHz mono samples; with `convertTo`, also writes it there
 * as AAC (one pass), for the players that cannot read the original (iOS and WebM/Opus).
 */
export function decodeWithFfmpeg(
  ffmpeg: string,
  input: string,
  convertTo?: string,
): Promise<Float32Array> {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input];
  if (convertTo) {
    args.push('-map', '0:a:0', '-ac', '1', '-c:a', 'aac', '-b:a', '64k');
    args.push('-movflags', '+faststart', convertTo);
  }
  args.push('-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.length < 2_000) errors += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error(`ffmpeg introuvable (${ffmpeg}) : installe-le ou règle MOWBOT_FFMPEG`)
          : error,
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const why = errors.trim().split('\n').at(-1) || (signal ? `arrêté (${signal})` : '');
        reject(new Error(`ffmpeg n'a pas pu lire l'enregistrement${why ? ` : ${why}` : ''}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      // A copy: the buffer may not be aligned on 4 bytes.
      const usable = pcm.subarray(0, pcm.length - (pcm.length % 4));
      resolve(new Float32Array(new Uint8Array(usable).buffer));
    });
  });
}

/**
 * The samples of a recording (16 kHz mono): WAV read here, the rest through ffmpeg, which also
 * converts it to `convertTo` when asked.
 */
export async function decodeRecording(
  ffmpeg: string,
  input: string,
  convertTo?: string,
): Promise<Float32Array> {
  if (path.extname(input).toLowerCase() === '.wav') {
    const samples = parseWav(await readFile(input));
    if (samples) return samples;
  }
  return decodeWithFfmpeg(ffmpeg, input, convertTo);
}
