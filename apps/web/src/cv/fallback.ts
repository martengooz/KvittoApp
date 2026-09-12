/**
 * Canvas-only image pipeline, used when OpenCV cannot load.
 *
 * OpenCV is an 11 MB download that a first-time user on a bad connection may
 * not have yet, and some locked-down browsers block WASM outright. Scanning is
 * the app's whole purpose, so it must not hard-fail: this fallback does no
 * document detection, but it still deskews nothing, downscales properly and
 * applies a grayscale contrast stretch, which is usually enough for a model to
 * read a receipt that was photographed reasonably straight.
 */

import type { PipelineOptions, PipelineResult } from './types.js';

export async function runCanvasPipeline(
  bitmap: ImageBitmap,
  options: PipelineOptions,
  notes: string[] = [],
): Promise<PipelineResult> {
  const started = performance.now();

  const rotated = options.rotate === 0 ? bitmap : await rotateBitmap(bitmap, options.rotate);
  const scale = Math.min(1, options.maxDimension / Math.max(rotated.width, rotated.height));
  const width = Math.max(1, Math.round(rotated.width * scale));
  const height = Math.max(1, Math.round(rotated.height * scale));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error('Could not get a 2D context for the fallback pipeline.');

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(rotated, 0, 0, width, height);
  if (rotated !== bitmap) rotated.close();

  if (options.enhance !== 'none' && options.enhance !== 'color') {
    const imageData = context.getImageData(0, 0, width, height);
    stretchGrayscale(imageData, options.enhance === 'binarize');
    context.putImageData(imageData, 0, 0);
  }

  const blob = await toBlob(canvas, options);
  return {
    blob,
    width,
    height,
    corners: null,
    detection: 'full-frame',
    detectionConfidence: 0,
    engine: 'canvas',
    durationMs: Math.round(performance.now() - started),
    notes: [
      ...notes,
      'OpenCV kunde inte laddas — bilden beskars inte automatiskt.',
    ],
  };
}

/**
 * Converts to grayscale and stretches contrast between the 2nd and 98th
 * percentile.
 *
 * Percentiles rather than min/max: a single dark speck or a blown-out highlight
 * would otherwise anchor the range and leave the actual paper occupying a
 * narrow band in the middle.
 */
function stretchGrayscale(imageData: ImageData, binarize: boolean): void {
  const { data } = imageData;
  const histogram = new Uint32Array(256);

  for (let index = 0; index < data.length; index += 4) {
    // Rec. 601 luma, which matches how the eye weighs the channels.
    const luma = (data[index]! * 299 + data[index + 1]! * 587 + data[index + 2]! * 114) / 1000;
    const value = luma | 0;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    histogram[value]! += 1;
  }

  const pixels = data.length / 4;
  const low = percentile(histogram, pixels, 0.02);
  const high = percentile(histogram, pixels, 0.98);
  const span = Math.max(1, high - low);
  const midpoint = (low + high) / 2;

  for (let index = 0; index < data.length; index += 4) {
    const value = data[index]!;
    const stretched = binarize
      ? value < midpoint ? 0 : 255
      : Math.max(0, Math.min(255, Math.round(((value - low) / span) * 255)));
    data[index] = stretched;
    data[index + 1] = stretched;
    data[index + 2] = stretched;
  }
}

function percentile(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    cumulative += histogram[value]!;
    if (cumulative >= target) return value;
  }
  return 255;
}

async function rotateBitmap(bitmap: ImageBitmap, degrees: 90 | 180 | 270): Promise<ImageBitmap> {
  const swap = degrees !== 180;
  const width = swap ? bitmap.height : bitmap.width;
  const height = swap ? bitmap.width : bitmap.height;

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error('Could not get a 2D context to rotate the image.');

  context.translate(width / 2, height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  return createImageBitmap(canvas as never);
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas: OffscreenCanvas | HTMLCanvasElement, options: PipelineOptions): Promise<Blob> {
  const type = options.enhance === 'binarize' ? 'image/png' : 'image/jpeg';
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality: options.quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas produced no image data.'))),
      type,
      options.quality,
    );
  });
}
