/**
 * Main-thread facade over the CV worker.
 *
 * Owns the worker lifecycle, matches responses to requests, and falls back to
 * the canvas pipeline whenever OpenCV is unavailable or errors out — the app
 * must always be able to produce *some* scan.
 */

import { runCanvasPipeline } from './fallback.js';
import {
  DEFAULT_PIPELINE_OPTIONS,
  type DetectionSource,
  type PipelineOptions,
  type PipelineResult,
  type Quad,
  type WorkerRequest,
  type WorkerResponse,
} from './types.js';

/** Rejects a scan that hangs, rather than leaving the UI spinning forever. */
const REQUEST_TIMEOUT_MS = 90_000;

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CvStatus {
  /** Whether OpenCV has successfully initialised in the worker. */
  ready: boolean;
  /** True while the runtime is downloading or initialising. */
  loading: boolean;
  version: string | null;
  /** Why OpenCV is unavailable, when it is. */
  error: string | null;
}

class CvClient {
  #worker: Worker | null = null;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #status: CvStatus = { ready: false, loading: false, version: null, error: null };
  #warmup: Promise<boolean> | null = null;

  get status(): CvStatus {
    return { ...this.#status };
  }

  /**
   * Starts loading OpenCV. Safe to call repeatedly; resolves to whether the
   * runtime is usable. Called on the scan screen so the download overlaps with
   * the user framing their shot.
   */
  warmup(): Promise<boolean> {
    this.#warmup ??= this.#doWarmup().finally(() => {
      // Allow a later retry once a failed attempt has settled.
      if (!this.#status.ready) this.#warmup = null;
    });
    return this.#warmup;
  }

  async #doWarmup(): Promise<boolean> {
    if (this.#status.ready) return true;
    this.#status = { ...this.#status, loading: true, error: null };
    try {
      const response = await this.#send({ type: 'warmup', id: 0 });
      if (response.type !== 'warmup') throw new Error('Unexpected warmup response.');
      this.#status = { ready: response.ready, loading: false, version: response.version, error: null };
      return response.ready;
    } catch (error) {
      this.#status = {
        ready: false,
        loading: false,
        version: null,
        error: error instanceof Error ? error.message : String(error),
      };
      return false;
    }
  }

  /**
   * Finds the receipt's corners without producing an image. Used by the crop
   * editor to seed its handles. Returns `null` when detection is unavailable.
   */
  async detect(bitmap: ImageBitmap): Promise<{
    corners: Quad | null;
    detection: DetectionSource;
    confidence: number;
  } | null> {
    if (!(await this.warmup())) {
      bitmap.close();
      return null;
    }
    try {
      const response = await this.#send({ type: 'detect', id: 0, image: bitmap }, [bitmap]);
      if (response.type !== 'detect') throw new Error('Unexpected detect response.');
      return {
        corners: response.corners,
        detection: response.detection,
        confidence: response.detectionConfidence,
      };
    } catch (error) {
      console.warn('Document detection failed', error);
      return null;
    }
  }

  /**
   * Runs the full pipeline. Consumes `bitmap`.
   *
   * Never throws for image-processing reasons: an OpenCV failure degrades to
   * the canvas pipeline so the user still gets a scan they can send to the model.
   */
  async process(bitmap: ImageBitmap, overrides: Partial<PipelineOptions> = {}): Promise<PipelineResult> {
    const options: PipelineOptions = { ...DEFAULT_PIPELINE_OPTIONS, ...overrides };

    if (!(await this.warmup())) {
      const reason = this.#status.error;
      return runCanvasPipeline(bitmap, options, reason ? [reason] : []);
    }

    // The worker consumes the bitmap, so keep a copy for the fallback path.
    const spare = await createImageBitmap(bitmap);
    try {
      const response = await this.#send({ type: 'process', id: 0, image: bitmap, options }, [bitmap]);
      if (response.type !== 'process') throw new Error('Unexpected process response.');
      spare.close();
      return {
        blob: response.blob,
        width: response.width,
        height: response.height,
        corners: response.corners,
        detection: response.detection,
        detectionConfidence: response.detectionConfidence,
        engine: 'opencv',
        durationMs: response.durationMs,
        notes: response.notes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('OpenCV pipeline failed, falling back to canvas', error);
      return runCanvasPipeline(spare, options, [`OpenCV-felet: ${message}`]);
    }
  }

  /** Tears the worker down, e.g. after leaving the scan screen for a while. */
  dispose(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CV worker was shut down.'));
    }
    this.#pending.clear();
    this.#worker?.terminate();
    this.#worker = null;
    this.#status = { ready: false, loading: false, version: null, error: null };
    this.#warmup = null;
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;

    const worker = new Worker(new URL('./cv.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      clearTimeout(pending.timer);
      if (event.data.type === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    });
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'CV worker crashed.');
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      // A crashed worker cannot be reused; the next call builds a fresh one.
      this.#worker?.terminate();
      this.#worker = null;
      this.#status = { ready: false, loading: false, version: null, error: error.message };
      this.#warmup = null;
    });

    this.#worker = worker;
    return worker;
  }

  #send(request: WorkerRequest, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    const message = { ...request, id } as WorkerRequest;

    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Bildbehandlingen tog för lång tid.'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage(message, transfer);
    });
  }
}

export const cvClient = new CvClient();

/** Decodes a file or blob into an `ImageBitmap`, honouring EXIF orientation. */
export async function decodeImage(source: Blob): Promise<ImageBitmap> {
  // `imageOrientation: 'from-image'` matters for phone photos: without it a
  // portrait shot arrives rotated 90° and every downstream step is wrong.
  return createImageBitmap(source, { imageOrientation: 'from-image' });
}
