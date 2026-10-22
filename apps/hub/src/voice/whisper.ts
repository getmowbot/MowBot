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

/** Waits between tries of a download cut short (then it gives up). */
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000, 8_000, 13_000];

/**
 * Downloads that survive a flaky network: a connection reset (before or during the body) is
 * tried again, and a file comes back whole or not at all. HTTP answers are not retried.
 */
export function retryingFetch(
  fetchImpl: typeof fetch,
  delays: readonly number[] = RETRY_DELAYS_MS,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetchImpl(input, init);
        if (!response.ok || init?.method === 'HEAD') return response;
        // Read here: a cut in the middle of a model file is retried too.
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || init?.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }) as typeof fetch;
}

/**
 * The model from the disk when it is all there, with Hugging Face out of reach (`remote(false)`:
 * transformers.js checks some files online even when cached, and a network that cuts
 * connections then failed every recording); from Hugging Face otherwise, the first time, kept
 * for the next ones.
 */
export async function loadModel<T>(
  load: (options: Record<string, unknown>) => Promise<T>,
  options: Record<string, unknown>,
  remote: (allowed: boolean) => void,
): Promise<T> {
  remote(false);
  try {
    return await load({ ...options, local_files_only: true });
  } catch {
    // Not all on the disk yet.
  } finally {
    remote(true);
  }
  return load(options);
}

/** transformers.js downloads through `env.fetch`: wrapped once. */
const RETRYING = Symbol('mowbot.retrying');

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
      const { env, pipeline } = await import('@huggingface/transformers');
      // The first recording downloads the model: a flaky connection must not fail it.
      const current = env.fetch as typeof fetch & { [RETRYING]?: true };
      if (!current[RETRYING]) {
        env.fetch = Object.assign(retryingFetch(current), { [RETRYING]: true as const });
      }
      // pipeline() lists the model's files without its cache_dir (transformers.js 4.3), from the
      // default cache: the same folder, or it looks for them on Hugging Face every time.
      env.cacheDir = this.options.cacheDir;
      const threads = Math.max(1, Math.floor(availableParallelism() / 2));
      return (await loadModel(
        (options) => pipeline('automatic-speech-recognition', this.options.model, options),
        {
          cache_dir: this.options.cacheDir,
          device: 'cpu',
          // The encoder loses accuracy when quantized; the decoder hardly does.
          dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
          session_options: { intraOpNumThreads: threads },
        },
        (allowed) => {
          env.allowRemoteModels = allowed;
        },
      )) as unknown as SpeechPipeline;
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
