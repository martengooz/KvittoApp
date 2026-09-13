/**
 * Preparing an image for Tesseract.
 *
 * The surprising part of this module is how little it does — and that is a
 * measured result, not an omission. Every OpenCV finish the scan pipeline
 * offers was tried against the receipt photographs in `fixtures/`, and every
 * one of them made OCR *worse* than the untouched camera frame:
 *
 * | input to Tesseract                    | organisation numbers found |
 * | ------------------------------------- | -------------------------- |
 * | flattened + CLAHE + unsharp, upscaled | 1 of 9                     |
 * | deskewed warp, no tonal work          | 4 of 9                     |
 * | the original frame                    | 5 of 9                     |
 *
 * Cropping to the detected document, without warping or resampling, made no
 * difference either way, so it is not done.
 *
 * The reason is that Tesseract is not a naive consumer. Leptonica already runs
 * its own local binarisation and deskew, and it is tuned for photographs.
 * Feeding it an image whose contrast has been stretched and whose strokes have
 * been sharpened removes the very gradients that binarisation reads, and every
 * resample — the perspective warp included — softens the 1 px strokes of
 * thermal print. The enhancement that makes a scan pleasant for a human, and
 * legible for a vision model, is actively destructive here.
 *
 * So the OCR path takes the original capture and does exactly one thing to it:
 * bounds its size, because a 24 MP frame costs seconds of recognition for text
 * that was already resolved at a third of that.
 */

/**
 * Longest edge handed to Tesseract, in pixels.
 *
 * Also measured rather than guessed. Against the fixtures, 2400 px finds the
 * same organisation numbers as an untouched 24 MP frame in roughly a third of
 * the time. Dropping to 1800 keeps the organisation numbers but starts
 * misreading dates — `2026-07-22` came back as `2022-07-06` — and a wrong date
 * filed silently is worse than no date at all, so the extra 600 px stays.
 */
const MAX_DIMENSION = 2400;

/** Re-encode quality. High, because JPEG ringing costs characters. */
const QUALITY = 0.95;

/**
 * Returns an image ready for the OCR client to recognise.
 *
 * Always redraws, even when no scaling is needed: the redraw is what bakes in
 * EXIF orientation, and a portrait phone photo read sideways costs Tesseract a
 * whole extra pass to recover. Next to recognition itself the canvas pass is
 * free. Falls back to the untouched source if anything goes wrong — OCR on a
 * slightly oversized image beats no OCR at all.
 */
export async function prepareForOcr(source: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height, 1));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const context = canvas.getContext('2d');
      if (!context) return source;

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.warn('Could not prepare the image for OCR; using it as captured', error);
    return source;
  }
}
