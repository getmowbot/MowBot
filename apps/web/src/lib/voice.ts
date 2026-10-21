/** Voice messages: recording in the browser, and the waveform drawn for them. */

/** A recording stops by itself after this long. */
export const MAX_RECORDING_MS = 10 * 60_000;
/** Shorter than this, a click on the mic was not meant as a message. */
export const MIN_RECORDING_MS = 600;
/** Waveform bars sent to the hub. */
export const PEAK_COUNT = 64;
/** How often the level is read while recording. */
const LEVEL_EVERY_MS = 50;

/** `0:07`, `1:32`, `12:05` */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * `count` bars from the levels read while recording: the mean of each slice, the loudest at 1,
 * lifted by a square root so soft speech still shows (as the hub draws them).
 */
export function toPeaks(levels: number[], count = PEAK_COUNT): number[] {
  if (levels.length === 0) return [];
  const bars = Math.min(count, levels.length);
  const means = Array.from({ length: bars }, (_, bar) => {
    const slice = levels.slice(
      Math.floor((bar * levels.length) / bars),
      Math.floor(((bar + 1) * levels.length) / bars),
    );
    return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
  });
  const loudest = Math.max(...means);
  if (loudest <= 0) return means.map(() => 0);
  return means.map((value) => Math.round(Math.sqrt(value / loudest) * 100) / 100);
}

/** The waveform fit to `count` bars: the loudest of the ones merged, or stretched. */
export function fitPeaks(peaks: number[], count: number): number[] {
  if (peaks.length === 0) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, bar) => {
    const start = Math.floor((bar * peaks.length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * peaks.length) / count));
    return Math.max(...peaks.slice(start, end));
  });
}

export interface Recording {
  blob: Blob;
  /** What the browser recorded in (`audio/webm`, `audio/mp4`…). */
  mimeType: string;
  durationMs: number;
  peaks: number[];
}

/** Formats in order of preference: Opus where it exists, AAC on Safari. */
const FORMATS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export const canRecord = () =>
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  Boolean(navigator.mediaDevices?.getUserMedia);

/** The file name the hub gets, from the type recorded. */
export const recordingName = (mimeType: string) =>
  mimeType.includes('mp4') ? 'voice.m4a' : mimeType.includes('ogg') ? 'voice.ogg' : 'voice.webm';

/**
 * The microphone, recording: the level is read every 50 ms (for the live bars, and the waveform
 * sent along). `stop` gives the recording, `cancel` drops it; both free the microphone.
 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private timer: number | undefined;
  private chunks: Blob[] = [];
  private startedAt = 0;
  readonly levels: number[] = [];

  /** Asks for the microphone (rejects when refused) and starts recording. */
  async start(onLevel: (level: number) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = FORMATS.find((type) => MediaRecorder.isTypeSupported(type));
    this.recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 48_000,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.context = new AudioContext();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    this.timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.sqrt(sum / samples.length);
      this.levels.push(level);
      onLevel(level);
    }, LEVEL_EVERY_MS);
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  get elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0;
  }

  stop(): Promise<Recording> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error('Not recording'));
    const durationMs = Math.round(this.elapsedMs);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || 'audio/webm';
        resolve({
          blob: new Blob(this.chunks, { type: mimeType }),
          mimeType,
          durationMs,
          peaks: toPeaks(this.levels),
        });
        this.release();
      };
      recorder.stop();
    });
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private release(): void {
    window.clearInterval(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.recorder = null;
    this.stream = null;
    this.context = null;
  }
}
