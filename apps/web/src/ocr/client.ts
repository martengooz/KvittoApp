/**
 * OCR, via Tesseract.
 *
 * OpenCV cannot do this. Its standard `opencv.js` build ships neither the
 * `text` contrib module nor `dnn`, so it has no character recognition at all —
 * what it contributes here is the part it is genuinely good at: finding the
 * paper, flattening the lighting and producing a clean, high-contrast,
 * deskewed image. Tesseract then reads that.
 *
 * Everything is self-hosted from `/vendor/` and fetched on first use, so OCR
 * works offline after one successful run and costs nothing before it. All
 * three assets are runtime-cached by the service worker, never precached.
 */

import { createWorker, type Worker } from 'tesseract.js';

/** Where `scripts/prepare-vendor.mjs` stages the runtime. */
const base = import.meta.env.BASE_URL;
const WORKER_PATH = `${base}vendor/tesseract/worker.min.js`;
const CORE_DIR = `${base}vendor/tesseract/core`;
const LANG_PATH = `${base}vendor/tessdata`;

export interface OcrWord {
  text: string;
  /** 0..100, as Tesseract reports it. */
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0..100. */
  confidence: number;
  words: OcrWord[];
  durationMs: number;
}

export interface OcrStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
}

/**
 * Picks the WASM core this browser can actually run.
 *
 * Only the SIMD and plain LSTM builds are staged, so the choice is a single
 * feature test rather than tesseract.js's own probing — which would try to
 * fetch variants that are deliberately not deployed.
 */
function corePath(): string {
  return `${CORE_DIR}/${hasWasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`;
}

/** Compiles a tiny module that uses one SIMD opcode. */
function hasWasmSimd(): boolean {
  try {
    // (module (func (result v128) i32.const 0 i8x16.splat))
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
        10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

class OcrClient {
  #worker: Worker | null = null;
  #starting: Promise<Worker | null> | null = null;
  #status: OcrStatus = { ready: false, loading: false, error: null };
  #language = 'swe';

  get status(): OcrStatus {
    return { ...this.#status };
  }

  /**
   * Starts the OCR engine, downloading its runtime on first call.
   * Resolves to whether OCR is usable; never throws.
   */
  async warmup(language = 'swe'): Promise<boolean> {
    if (this.#worker && this.#language === language) return true;
    if (this.#language !== language) await this.dispose();

    this.#language = language;
    this.#starting ??= this.#start(language).finally(() => {
      this.#starting = null;
    });
    return (await this.#starting) !== null;
  }

  async #start(language: string): Promise<Worker | null> {
    this.#status = { ready: false, loading: true, error: null };
    try {
      const worker = await createWorker(language, 1, {
        workerPath: WORKER_PATH,
        corePath: corePath(),
        langPath: LANG_PATH,
        // The models are already gzipped on disk and served as-is.
        gzip: true,
        // Tesseract caches models in IndexedDB itself; the service worker also
        // caches the HTTP response, so a second device profile is still fast.
        cacheMethod: 'refresh',
      });

      await worker.setParameters({
        // Receipts are a single column of text. Telling Tesseract that stops
        // it hunting for a page layout that is not there.
        tessedit_pageseg_mode: '4' as never,
        // Keeps spaces between columns, which is what separates a product name
        // from its price on the same line.
        preserve_interword_spaces: '1',
      });

      this.#worker = worker;
      this.#status = { ready: true, loading: false, error: null };
      return worker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#status = { ready: false, loading: false, error: message };
      console.warn('OCR engine failed to start', error);
      return null;
    }
  }

  /**
   * Reads text from an image. Returns `null` when OCR is unavailable, rather
   * than throwing — every caller treats OCR as optional enrichment.
   */
  async recognize(image: Blob, language = 'swe'): Promise<OcrResult | null> {
    if (!(await this.warmup(language))) return null;
    const worker = this.#worker;
    if (!worker) return null;

    const started = performance.now();
    try {
      const { data } = await worker.recognize(image, {}, { blocks: true });
      const words = collectWords(data);
      return {
        text: data.text ?? '',
        confidence: data.confidence ?? 0,
        words,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      console.warn('OCR failed', error);
      return null;
    }
  }

  async dispose(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    this.#status = { ready: false, loading: false, error: null };
    if (worker) await worker.terminate().catch(() => undefined);
  }
}

/**
 * Flattens Tesseract's block/paragraph/line/word tree into a word list.
 *
 * The shape varies between versions and between the `blocks` options, so this
 * walks defensively rather than assuming a fixed depth.
 */
function collectWords(data: unknown): OcrWord[] {
  const words: OcrWord[] = [];

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;

    const text = record['text'];
    const bbox = record['bbox'] as OcrWord['bbox'] | undefined;
    const confidence = record['confidence'];
    // A node with a bbox, text and no children of its own is a word.
    if (typeof text === 'string' && bbox && typeof confidence === 'number' && !record['words']) {
      words.push({ text, confidence, bbox });
    }

    for (const key of ['blocks', 'paragraphs', 'lines', 'words']) {
      const children = record[key];
      if (Array.isArray(children)) for (const child of children) visit(child);
    }
  };

  visit(data);
  return words;
}

export const ocrClient = new OcrClient();
