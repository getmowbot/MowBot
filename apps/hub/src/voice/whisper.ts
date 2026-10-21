import { availableParallelism } from 'node:os';
import type { Logger } from '../computers/service';

/** Turns speech into text. */
export interface Transcriber {
  /** What is said in 16 kHz mono samples, spoken in `language` (ISO code: `fr`, `en`…). */
  transcribe(samples: Float32Array, language: string): Promise<string>;
  close?(): Promise<void>;
}

/** The part of a transformers.js speech pipeline used here. */
interface SpeechPipeline {
  (
    audio: Float32Array,
    options: Record<string, unknown>,
  ): Promise<{ text: string } | { text: string }[]>;
  dispose(): Promise<void>;
}

/** Unused this long, the model leaves the memory (it reloads from disk in a few seconds). */
const IDLE_UNLOAD_MS = 10 * 60_000;

/**
 * Whisper run on the hub's CPU with transformers.js (ONNX): no audio leaves the server. The
 * model is downloaded from Hugging Face on first use and kept in `cacheDir`. One recording at a
 * time, on half the cores, so the hub stays responsive.
 */
export class WhisperTranscriber implements Transcriber {
  private model: Promise<SpeechPipeline> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private running = 0;

  constructor(
    private readonly options: { model: string; cacheDir: string; log?: Logger; idleMs?: number },
  ) {}

  private load(): Promise<SpeechPipeline> {
    this.model ??= (async () => {
      // Loaded on demand: the ONNX runtime is heavy and most hubs start without a recording.
      const { pipeline } = await import('@huggingface/transformers');
      const threads = Math.max(1, Math.floor(availableParallelism() / 2));
      return (await pipeline('automatic-speech-recognition', this.options.model, {
        cache_dir: this.options.cacheDir,
        device: 'cpu',
        // The encoder loses accuracy when quantized; the decoder hardly does.
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        session_options: { intraOpNumThreads: threads },
      })) as unknown as SpeechPipeline;
    })().catch((error: unknown) => {
      this.model = null;
      throw error;
    });
    return this.model;
  }

  transcribe(samples: Float32Array, language: string): Promise<string> {
    clearTimeout(this.idleTimer);
    this.running++;
    const job = this.queue.then(async () => {
      const asr = await this.load();
      const result = await asr(samples, {
        language,
        task: 'transcribe',
        // Longer than 30 s: windows overlapping by 5 s, stitched back together.
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      return (Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text).trim();
    });
    this.queue = job.catch(() => {});
    void job
      .finally(() => {
        this.running--;
        if (this.running === 0) this.planUnload();
      })
      .catch(() => {});
    return job;
  }

  private planUnload(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      const model = this.model;
      this.model = null;
      void model
        ?.then((asr) => asr.dispose())
        .catch((error) => this.options.log?.warn({ err: error }, 'Could not unload Whisper'));
    }, this.options.idleMs ?? IDLE_UNLOAD_MS);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const model = this.model;
    this.model = null;
    await model?.then((asr) => asr.dispose()).catch(() => {});
  }
}
