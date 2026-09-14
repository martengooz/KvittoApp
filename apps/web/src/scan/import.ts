/**
 * Unattended import: photographs in, receipts out.
 *
 * The camera path asks the user to check the crop before saving, which is
 * right for one deliberate shot. It is wrong for a pile of photographs already
 * in the gallery: nobody wants to approve eight crops in a row, and the
 * approval adds nothing when the detector is confident. So this path decides
 * the crop itself, files each image as its own receipt, and lets the reading
 * and the model run afterwards while the user looks at the list.
 *
 * Two rules keep "no human in the loop" honest:
 *
 * 1. **An unsure crop is no crop.** The review screen exists to catch a wrong
 *    outline; without it, a confidently wrong quad would silently cut the price
 *    column off a receipt with no way to get it back. A whole-frame scan is
 *    untidy but complete, and both the model and the OCR pass read it fine, so
 *    a weak detection falls back to the full frame rather than gambling.
 * 2. **One bad image never costs the others.** Every step per image is
 *    contained: a file that will not decode is reported and the rest still
 *    import.
 */

import type { ID, ReceiptSource } from '@kvitto/shared';

import { getSettings, isAiConfigured } from '../core/settings.js';
import { cvClient, decodeImage } from '../cv/client.js';
import type { PipelineResult } from '../cv/types.js';
import { putBlob } from '../db/blobs.js';
import { createReceipt } from '../db/repo.js';
import { enrichFromImage } from '../ocr/enrich.js';
import { parseReceipt } from '../ai/index.js';

/**
 * Below this the detector's outline is not trusted on its own.
 *
 * The same threshold the review screen uses to tell a user "check these
 * corners" — with nobody there to check them, it means "use the whole frame".
 */
const UNCERTAIN_CROP = 0.45;

export interface ImportProgress {
  /** How many images the batch holds. */
  total: number;
  /** 1-based index of the image being worked on. */
  index: number;
  name: string;
  /** Receipts created so far. */
  imported: number;
}

export interface ImportFailure {
  name: string;
  message: string;
}

export interface ImportOutcome {
  /** Created receipts, in the order their images were picked. */
  receiptIds: ID[];
  /** Images whose crop fell back to the whole frame because detection was unsure. */
  uncropped: number;
  failures: ImportFailure[];
  /** Whether extraction was started for the imported receipts. */
  parsing: boolean;
}

/**
 * Imports every image as its own receipt.
 *
 * Resolves once the images are cropped and saved — the point at which they are
 * all in the list. The reading and the extraction keep running afterwards; they
 * are deliberately not awaited, and deliberately not tied to the screen that
 * started them, so leaving the scan screen does not abandon them.
 */
export async function importImages(
  files: readonly File[],
  options: { source: ReceiptSource; onProgress?: (progress: ImportProgress) => void },
): Promise<ImportOutcome> {
  const receiptIds: ID[] = [];
  const failures: ImportFailure[] = [];
  const readings: { id: ID; image: Blob }[] = [];
  const parsing = shouldParse();
  let uncropped = 0;

  for (const [index, file] of files.entries()) {
    const name = file.name || `Bild ${index + 1}`;
    options.onProgress?.({ total: files.length, index: index + 1, name, imported: receiptIds.length });

    try {
      const cropped = await crop(file);
      if (cropped.fellBack) uncropped += 1;

      const id = await store(file, cropped, options.source);
      receiptIds.push(id);
      readings.push({ id, image: file });

      // Queued as each receipt lands rather than after the batch: extraction is
      // network-bound, so it runs happily alongside the cropping of the next
      // image and the first results are back sooner.
      if (parsing) queueParse(id);
    } catch (error) {
      console.error('Could not import an image', error);
      failures.push({ name, message: describe(error) });
    }
  }

  options.onProgress?.({
    total: files.length,
    index: files.length,
    name: '',
    imported: receiptIds.length,
  });

  // The reading waits for the whole batch: Tesseract and OpenCV compete for the
  // same cores, and slowing the cropping down would keep the user waiting on
  // the one part of this they actually watch.
  for (const reading of readings) queueRead(reading.id, reading.image);

  return { receiptIds, uncropped, failures, parsing };
}

/** Whether a freshly imported receipt should be handed to the model. */
export function shouldParse(): boolean {
  const settings = getSettings();
  return isAiConfigured(settings) && settings.ai.autoParse;
}

interface CroppedImage {
  result: PipelineResult;
  /** Whether the detected outline was discarded in favour of the whole frame. */
  fellBack: boolean;
  /** Dimensions of the original capture, for the stored blob's metadata. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Crops one image, deciding for itself whether to trust the outline.
 *
 * Reports whether it gave up on the detected outline, because a batch where
 * half the crops fell through is worth telling the user about.
 */
async function crop(file: Blob): Promise<CroppedImage> {
  const settings = getSettings().image;
  const base = {
    enhance: settings.enhance,
    maxDimension: settings.maxDimension,
    quality: settings.quality,
    corners: null,
    rotate: 0 as const,
  };

  // Decoded once here and measured before the worker consumes it; the second
  // pass below is the rare path and can afford its own decode.
  const bitmap = await decodeImage(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;

  const result = await cvClient.process(bitmap, { ...base, detectEdges: settings.detectEdges });

  const unsure = result.detection !== 'full-frame' && result.detectionConfidence < UNCERTAIN_CROP;
  if (!unsure) return { result, fellBack: false, sourceWidth, sourceHeight };

  // Re-run rather than reuse: the first pass warped to the outline it no longer
  // trusts, so its pixels are already the wrong ones.
  const whole = await cvClient.process(await decodeImage(file), { ...base, detectEdges: false });
  return { result: whole, fellBack: true, sourceWidth, sourceHeight };
}

/** Stores the scan, the original and the thumbnail, and creates the receipt. */
async function store(source: Blob, cropped: CroppedImage, from: ReceiptSource): Promise<ID> {
  const { result } = cropped;

  const imageId = await putBlob(result.blob, {
    role: 'processed',
    width: result.width,
    height: result.height,
  });

  let originalImageId: string | null = null;
  if (getSettings().image.keepOriginal) {
    originalImageId = await putBlob(source, {
      role: 'original',
      width: cropped.sourceWidth,
      height: cropped.sourceHeight,
    });
  }

  const receipt = await createReceipt({
    source: from,
    imageId,
    originalImageId,
    thumbId: await makeThumbnail(result.blob),
    status: 'draft',
  });
  return receipt.id;
}

/**
 * Builds a small thumbnail for the list view.
 *
 * Worth the extra blob: the list would otherwise decode several full-size
 * scans at once, which is what makes a receipt archive feel slow on a phone.
 */
export async function makeThumbnail(source: Blob, size = 200): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.72),
    );
    if (!blob) return null;
    return putBlob(blob, { role: 'thumb', width, height });
  } catch (error) {
    // A missing thumbnail is cosmetic; never let it block saving a receipt.
    console.warn('Could not build a thumbnail', error);
    return null;
  }
}

// --- background queues ----------------------------------------------------

/**
 * Both queues are module state rather than per-batch, so a second batch picked
 * while the first is still working lines up behind it instead of competing with
 * it — and neither ends when the screen that started it goes away.
 *
 * One at a time in each: Tesseract is a single worker, and firing twenty
 * extractions at a provider at once is the fastest way to meet a rate limit.
 * The two run alongside each other because they contend for different things —
 * one for the CPU, the other for the network.
 */
let reading: Promise<unknown> = Promise.resolve();
let extraction: Promise<unknown> = Promise.resolve();

function queueRead(receiptId: ID, image: Blob): void {
  reading = reading.then(() =>
    // Reads the untouched capture rather than the processed scan: measured
    // against the fixtures, the enhancement that makes a good scan makes a
    // materially worse OCR input. See `ocr/prepare.ts`.
    enrichFromImage(receiptId, image).catch((error: unknown) => {
      console.warn('OCR enrichment failed', error);
      return null;
    }),
  );
}

function queueParse(receiptId: ID): void {
  extraction = extraction.then(() =>
    parseReceipt(receiptId).catch((error: unknown) => {
      // `parseReceipt` records its own failures on the receipt; this only
      // catches a throw from outside that contract, so the queue keeps moving.
      console.warn('Extraction failed', error);
      return null;
    }),
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
