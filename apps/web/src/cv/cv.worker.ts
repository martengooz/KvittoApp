/**
 * Module worker hosting OpenCV.js.
 *
 * OpenCV is loaded at runtime from a stable `/vendor/opencv.js` URL rather than
 * bundled, so the 11 MB payload stays out of the app bundle and out of the
 * service worker's precache (see `vite.config.ts`).
 *
 * It cannot be loaded with `importScripts`, which does not exist in a module
 * worker — and a classic worker is not an option either, because Vite serves
 * workers as ES modules in dev, so a classic worker would work in production
 * and break the moment anyone ran `vite dev`. Instead the UMD bundle is fetched
 * and evaluated in the worker's global scope, which is what `importScripts`
 * would have done anyway.
 */

import { describeError } from '@kvitto/shared';
import { detectDocument, warpAndEnhance } from './pipeline.js';
import type { DetectionSource, PipelineOptions, WorkerRequest, WorkerResponse } from './types.js';

type CV = typeof import('@techstark/opencv-js');

/**
 * Where `scripts/copy-opencv.mjs` puts the runtime.
 *
 * Built from `BASE_URL` rather than hard-coded to `/vendor/...`, because a
 * GitHub Pages project site is served from `/<repo>/` and an absolute path
 * would resolve against the domain root and 404.
 */
const OPENCV_URL = `${import.meta.env.BASE_URL}vendor/opencv.js`;

const scope = self as unknown as DedicatedWorkerGlobalScope & {
  cv?: unknown;
  importScripts?: unknown;
};

let cvPromise: Promise<CV> | null = null;

/**
 * Loads OpenCV once, on first use.
 *
 * Three details matter here:
 *
 * 1. `importScripts` is defined as a stub before evaluating. The UMD wrapper
 *    and emscripten both branch on `typeof importScripts === 'function'` to
 *    decide they are in a worker; without it they fall through to the generic
 *    "shell" path, which is the least-exercised of their environments. The stub
 *    throws rather than no-ops, so if this build ever does call it, that shows
 *    up as a clear error instead of a silent half-initialisation.
 * 2. Indirect `eval` runs the source in global scope, so the wrapper's
 *    `this` is the worker global and `self.cv` gets assigned.
 * 3. `self.cv` ends up holding a *promise* that resolves once the WASM runtime
 *    has initialised, so it must be awaited, not just read.
 */
function loadOpenCv(): Promise<CV> {
  cvPromise ??= (async () => {
    const response = await fetch(new URL(OPENCV_URL, scope.location.href));
    if (!response.ok) {
      throw new Error(`Could not fetch opencv.js (${response.status} ${response.statusText}).`);
    }
    const source = await response.text();

    if (typeof scope.importScripts !== 'function') {
      scope.importScripts = (...args: unknown[]): never => {
        throw new Error(`opencv.js called importScripts unexpectedly: ${String(args)}`);
      };
    }

    // Indirect eval, so the UMD wrapper evaluates against the worker global.
    (0, eval)(source);

    const pending = scope.cv;
    if (!pending) throw new Error('opencv.js loaded but did not expose `cv`.');
    // `scope.cv` is typed `unknown` because it is assigned by the eval'd UMD
    // bundle, not by anything this codebase declares — but at runtime it is
    // the promise opencv.js resolves once its WASM runtime is ready (see the
    // note above), so awaiting it is correct even though the type checker
    // cannot see that it is thenable.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const cv = (await pending) as CV;
    if (typeof cv.Mat !== 'function') throw new Error('opencv.js initialised without a Mat class.');
    return cv;
  })().catch((error: unknown) => {
    // Let the next attempt retry rather than caching the failure forever: a
    // first load can fail simply because the device was offline before the
    // runtime got cached.
    cvPromise = null;
    throw error;
  });
  return cvPromise;
}

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
});

async function handle(request: WorkerRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'warmup': {
        const cv = await loadOpenCv();
        const version = readVersion(cv);
        post({ type: 'warmup', id: request.id, ready: true, version });
        break;
      }
      case 'detect': {
        const cv = await loadOpenCv();
        const source = bitmapToMat(cv, request.image);
        try {
          const outcome = detectDocument(cv, source);
          post({
            type: 'detect',
            id: request.id,
            corners: outcome.corners,
            detection: outcome.detection,
            detectionConfidence: outcome.confidence,
          });
        } finally {
          source.delete();
          request.image.close();
        }
        break;
      }
      case 'process': {
        await process(request.id, request.image, request.options);
        break;
      }
    }
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: describeError(error),
    });
  }
}

async function process(id: number, image: ImageBitmap, options: PipelineOptions): Promise<void> {
  const started = performance.now();
  const cv = await loadOpenCv();
  const source = bitmapToMat(cv, image);
  try {
    let corners = options.corners;
    let detection: DetectionSource = 'manual';
    let confidence = 1;

    if (!corners && options.detectEdges) {
      const outcome = detectDocument(cv, source);
      corners = outcome.corners;
      detection = outcome.detection;
      confidence = outcome.confidence;
    } else if (!corners) {
      detection = 'full-frame';
      confidence = 0;
    }

    const { output, notes } = warpAndEnhance(cv, source, corners, options);
    try {
      const blob = await encode(output, options);
      post(
        {
          type: 'process',
          id,
          blob,
          width: output.cols,
          height: output.rows,
          corners,
          detection,
          detectionConfidence: confidence,
          durationMs: Math.round(performance.now() - started),
          notes,
        },
        [],
      );
    } finally {
      output.delete();
    }
  } finally {
    source.delete();
    image.close();
  }
}

/** Copies an `ImageBitmap` into an RGBA `Mat`. */
function bitmapToMat(cv: CV, bitmap: ImageBitmap): import('@techstark/opencv-js').Mat {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not get a 2D context in the worker.');
  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return cv.matFromImageData(imageData);
}

async function encode(mat: import('@techstark/opencv-js').Mat, options: PipelineOptions): Promise<Blob> {
  const canvas = new OffscreenCanvas(mat.cols, mat.rows);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D context for encoding.');

  const data = new Uint8ClampedArray(mat.data);
  context.putImageData(new ImageData(data, mat.cols, mat.rows), 0, 0);

  // Binarised output is two-tone: PNG stores it losslessly and smaller than
  // JPEG, whose ringing around hard edges would undo the thresholding.
  return options.enhance === 'binarize'
    ? canvas.convertToBlob({ type: 'image/png' })
    : canvas.convertToBlob({ type: 'image/jpeg', quality: options.quality });
}

function readVersion(cv: CV): string | null {
  const candidate = (cv as unknown as Record<string, unknown>)['CV_VERSION'];
  return typeof candidate === 'string' ? candidate : null;
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}
