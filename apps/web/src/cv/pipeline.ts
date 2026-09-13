/**
 * The OpenCV receipt-scanning pipeline. Runs inside the CV worker.
 *
 * Two stages, and the split matters:
 *
 * **Detect** finds the four corners of the paper. It works on a downscaled copy
 * (fast) and deliberately *destroys* the text — a large morphological close
 * turns the printed lines into flat paper so the only strong edge left is the
 * outline of the receipt itself. Text-preserving edge detection finds hundreds
 * of contours and none of them are the document.
 *
 * **Warp and enhance** runs on the full-resolution source. The single biggest
 * quality win for phone photos of receipts is not contrast or sharpening but
 * *illumination flattening*: dividing the image by a heavily blurred copy of
 * itself removes the shadow gradient cast by the phone and the user's hand, and
 * makes a uniform page out of one that was half in shade. CLAHE and a light
 * unsharp mask go on top of that.
 *
 * The output is deliberately **not** binarised by default. Hard thresholding
 * looks crisp to a human but throws away the faint, half-printed characters
 * that thermal receipts are full of, and vision models read those better from a
 * grayscale image with its anti-aliasing intact.
 */

import type { Mat } from '@techstark/opencv-js';
import type {
  DetectionSource,
  EnhanceMode,
  PipelineOptions,
  Point,
  Quad,
} from './types.js';

/** The OpenCV module, as loaded by the CV worker at runtime. */
// The upstream typings describe the module's shape but not its many enum
// constants as a single object, so the worker treats it structurally.
type CV = typeof import('@techstark/opencv-js');

/** Longest side of the copy the detector works on. */
const DETECT_WORKING_SIZE = 900;

/** Minimum share of the frame a candidate outline must cover to be believed. */
const MIN_AREA_RATIO = 0.12;

/**
 * Saturation (0..255) below which a pixel is treated as paper rather than
 * skin, wood or packaging. Thermal receipts sit near zero; skin measures
 * roughly 60-110 in the photos this was tuned against.
 */
const PAPER_MAX_SATURATION = 70;

/**
 * Fraction the detected outline is grown by before warping.
 *
 * The two failure modes are not symmetric. Cropping a little wide leaves a thin
 * border of table around the receipt, which costs nothing — a model reads the
 * receipt just the same. Cropping a little tight silently slices off the price
 * column, and no amount of downstream cleverness recovers a number that is not
 * in the image. So the detector is deliberately biased outwards.
 */
const CROP_MARGIN = 0.04;

/**
 * How far outside a candidate quad a detected paper pixel may sit before the
 * quad is rejected for cutting the document. Expressed as a fraction of the
 * quad's own size, so it scales with the receipt.
 */
const CONTAINMENT_TOLERANCE = 0.02;

/**
 * Tracks every `Mat` created in a scope so they can all be freed together.
 *
 * OpenCV.js allocates in WASM memory that the JS garbage collector cannot see.
 * A pipeline that leaks a few Mats per scan will exhaust the heap after a
 * couple of dozen receipts, and the failure looks like an unrelated crash, so
 * every allocation goes through here.
 */
class MatScope {
  readonly #mats: Mat[] = [];

  /** Registers `mat` for cleanup and returns it. */
  keep<T extends Mat>(mat: T): T {
    this.#mats.push(mat);
    return mat;
  }

  /**
   * Stops tracking `mat` and hands ownership to the caller, *without* freeing
   * it. Used to return a result out of a scope that frees everything else.
   */
  detach<T extends Mat>(mat: T): T {
    const index = this.#mats.indexOf(mat);
    if (index !== -1) this.#mats.splice(index, 1);
    return mat;
  }

  dispose(): void {
    for (const mat of this.#mats) {
      if (!mat.isDeleted()) mat.delete();
    }
    this.#mats.length = 0;
  }
}

export interface DetectionOutcome {
  corners: Quad | null;
  detection: DetectionSource;
  confidence: number;
}

/**
 * Finds the receipt's outline in `source` (an RGBA Mat at full resolution).
 * Returns corners in full-resolution coordinates.
 */
export function detectDocument(cv: CV, source: Mat): DetectionOutcome {
  const scope = new MatScope();
  try {
    const scale = Math.min(1, DETECT_WORKING_SIZE / Math.max(source.cols, source.rows));
    const working = scope.keep(new cv.Mat());
    if (scale < 1) {
      cv.resize(
        source,
        working,
        new cv.Size(Math.round(source.cols * scale), Math.round(source.rows * scale)),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      source.copyTo(working);
    }

    const gray = scope.keep(new cv.Mat());
    cv.cvtColor(working, gray, cv.COLOR_RGBA2GRAY);

    const blurred = scope.keep(new cv.Mat());
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

    // Flatten the print into paper: a close with a kernel wider than the text
    // strokes leaves only large-scale structure, i.e. the edge of the receipt.
    const closed = scope.keep(new cv.Mat());
    const closeKernel = scope.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
    cv.morphologyEx(blurred, closed, cv.MORPH_CLOSE, closeKernel);

    // Tried first because it is the only one of the three that knows what a
    // receipt *is*: bright and colourless. Plain brightness segmentation
    // happily swallows the hand holding the receipt; this does not.
    const fromPaper = findQuadByPaperMask(cv, scope, working);
    if (fromPaper) {
      return finish(fromPaper, 'paper', scale, working, source);
    }

    const fromContours = findQuadByEdges(cv, scope, closed);
    if (fromContours) {
      return finish(fromContours, 'contour', scale, working, source);
    }

    // Last resort — usually a low-contrast background, e.g. a white receipt on
    // a white table, where neither colour nor gradients separate the paper.
    const fromThreshold = findQuadByThreshold(cv, scope, blurred);
    if (fromThreshold) {
      return finish(fromThreshold, 'threshold', scale, working, source);
    }

    return { corners: null, detection: 'full-frame', confidence: 0 };
  } finally {
    scope.dispose();
  }
}

interface QuadCandidate {
  quad: Quad;
  /** Area of the quad, in working-copy pixels. */
  area: number;
  /** How closely the source contour fills its own quad, 0..1. */
  fill: number;
}

function finish(
  candidate: QuadCandidate,
  detection: DetectionSource,
  scale: number,
  working: Mat,
  source: Mat,
): DetectionOutcome {
  const frameArea = working.cols * working.rows;
  const coverage = candidate.area / frameArea;

  // Confidence blends "does it fill a sensible part of the frame" with "is the
  // contour actually rectangular". A tiny quad or a ragged blob scores low and
  // the review UI nudges the user to adjust the corners by hand.
  const coverageScore = Math.min(1, coverage / 0.55);
  const confidence = Math.max(0, Math.min(1, coverageScore * 0.55 + candidate.fill * 0.45));

  const inverse = scale < 1 ? 1 / scale : 1;
  const expanded = expandQuad(candidate.quad, CROP_MARGIN);
  const corners = expanded.map((point) => ({
    x: clamp(point.x * inverse, 0, source.cols),
    y: clamp(point.y * inverse, 0, source.rows),
  })) as Quad;

  return { corners, detection, confidence };
}

/**
 * Segments the receipt by what paper looks like: bright *and* near-colourless.
 *
 * Brightness alone is not enough. In a hand-held photo the hand is just as
 * bright as the receipt, and Otsu merges the two into one blob whose bounding
 * quad crops half the receipt away. Skin, wood and cardboard all carry
 * noticeable saturation, while thermal paper sits near zero, so intersecting a
 * low-saturation mask with a bright mask isolates the paper itself.
 */
function findQuadByPaperMask(cv: CV, scope: MatScope, working: Mat): QuadCandidate | null {
  const rgb = scope.keep(new cv.Mat());
  cv.cvtColor(working, rgb, cv.COLOR_RGBA2RGB);
  const hsv = scope.keep(new cv.Mat());
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

  const channels = new cv.MatVector();
  try {
    cv.split(hsv, channels);
    const saturation = scope.keep(channels.get(1));
    const value = scope.keep(channels.get(2));

    const colourless = scope.keep(new cv.Mat());
    cv.threshold(saturation, colourless, PAPER_MAX_SATURATION, 255, cv.THRESH_BINARY_INV);

    // Otsu rather than a fixed level, so the same code works for a receipt shot
    // in a dim shop and one on a sunlit table.
    const bright = scope.keep(new cv.Mat());
    cv.threshold(value, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    const paper = scope.keep(new cv.Mat());
    cv.bitwise_and(colourless, bright, paper);

    const kernel = scope.keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11)));
    // Open first to drop specks of bright background, then close to weld the
    // paper back into one region across the printed text.
    cv.morphologyEx(paper, paper, cv.MORPH_OPEN, kernel);
    cv.morphologyEx(paper, paper, cv.MORPH_CLOSE, kernel);

    return largestQuadInMask(cv, scope, paper, working.cols * working.rows);
  } finally {
    channels.delete();
  }
}

/** Auto-Canny plus polygon approximation over the largest external contours. */
function findQuadByEdges(cv: CV, scope: MatScope, prepared: Mat): QuadCandidate | null {
  const edges = scope.keep(new cv.Mat());
  const [lower, upper] = autoCannyThresholds(cv, scope, prepared);
  cv.Canny(prepared, edges, lower, upper);

  // Canny leaves single-pixel gaps at corners, which break the contour into
  // open arcs. One dilation reconnects them without merging separate objects.
  const dilateKernel = scope.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  cv.dilate(edges, edges, dilateKernel);

  return largestQuadInMask(cv, scope, edges, prepared.cols * prepared.rows);
}

/** Otsu segmentation, for scenes where the paper has no edge contrast. */
function findQuadByThreshold(cv: CV, scope: MatScope, blurred: Mat): QuadCandidate | null {
  const mask = scope.keep(new cv.Mat());
  cv.threshold(blurred, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  // Close small holes punched by dark print inside the paper region.
  const kernel = scope.keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15)));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

  return largestQuadInMask(cv, scope, mask, blurred.cols * blurred.rows);
}

function largestQuadInMask(cv: CV, scope: MatScope, mask: Mat, frameArea: number): QuadCandidate | null {
  const contours = new cv.MatVector();
  const hierarchy = scope.keep(new cv.Mat());
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const ranked: { index: number; area: number }[] = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = cv.contourArea(contour);
      contour.delete();
      if (area >= frameArea * MIN_AREA_RATIO) ranked.push({ index, area });
    }
    ranked.sort((a, b) => b.area - a.area);

    // Only the biggest few can plausibly be the page.
    for (const { index, area } of ranked.slice(0, 6)) {
      const contour = contours.get(index);
      try {
        const quad = approximateQuad(cv, contour, area);
        if (quad) return quad;
      } finally {
        contour.delete();
      }
    }
    return null;
  } finally {
    contours.delete();
  }
}

/**
 * Reduces a contour to four corners.
 *
 * A single `approxPolyDP` epsilon does not work across real photos: too small
 * and a slightly wavy paper edge stays a 7-gon, too large and the receipt
 * collapses to a triangle. Sweeping epsilon and taking the first 4-point convex
 * result is far more reliable than tuning one value.
 *
 * When no epsilon yields a quadrilateral — a crumpled or partly occluded
 * receipt — the contour's minimum-area rectangle is used instead. It is a worse
 * fit, and `fill` reports that honestly so the UI can ask for confirmation.
 */
function approximateQuad(cv: CV, contour: Mat, area: number): QuadCandidate | null {
  // Approximate the convex hull rather than the raw outline. A real receipt is
  // creased, dog-eared and often has a thumb over one edge, and every one of
  // those is a concave notch that stops the outline from ever reducing to four
  // points. The hull spans them, which is what the corners of the paper would
  // have done anyway.
  const hull = new cv.Mat();
  const approx = new cv.Mat();
  try {
    cv.convexHull(contour, hull, false, true);
    const shape = hull.rows >= 4 ? hull : contour;
    const perimeter = cv.arcLength(shape, true);
    const hullPoints = matToPoints(shape);

    for (const factor of [0.02, 0.015, 0.025, 0.01, 0.03, 0.04, 0.05]) {
      cv.approxPolyDP(shape, approx, factor * perimeter, true);
      if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;

      const points = matToPoints(approx);
      const quad = orderCorners(points);
      const quadArea = polygonArea(quad);
      if (quadArea <= 0) continue;
      // Reject wildly skewed results where the "quad" is a sliver.
      if (!hasSaneAspect(quad)) continue;
      // Douglas-Peucker minimises vertex count, not enclosed area: on a receipt
      // whose edge bulges, the four-point simplification can cut a chord across
      // the bulge and silently crop the price column off the side. A quad that
      // does not contain the detected paper is worse than no quad at all.
      if (!quadContainsAll(quad, hullPoints, CONTAINMENT_TOLERANCE)) continue;
      return { quad, area: quadArea, fill: Math.min(1, area / quadArea) };
    }

    // No epsilon produced a quadrilateral, so fall back to the contour's
    // minimum-area rectangle. It is a rougher fit — a receipt curled in the
    // hand is genuinely not a quadrilateral — so its `fill` is damped to push
    // the reported confidence down and prompt a manual check.
    const rotated = cv.minAreaRect(contour);
    const box = cv.RotatedRect.points(rotated);
    const quad = orderCorners(box.map((point) => ({ x: point.x, y: point.y })));
    const quadArea = polygonArea(quad);
    if (quadArea <= 0 || !hasSaneAspect(quad)) return null;
    return { quad, area: quadArea, fill: Math.min(1, area / quadArea) * 0.75 };
  } finally {
    approx.delete();
    hull.delete();
  }
}

/**
 * Canny thresholds derived from the image's own median intensity, so a dim
 * photo and a bright one both get usable edges without a hand-tuned constant.
 */
function autoCannyThresholds(cv: CV, scope: MatScope, image: Mat): [number, number] {
  const median = medianIntensity(cv, scope, image);
  const sigma = 0.33;
  const lower = Math.max(0, Math.round((1 - sigma) * median));
  const upper = Math.min(255, Math.round((1 + sigma) * median));
  // Guard against a flat image collapsing both thresholds onto each other.
  return upper - lower < 20 ? [Math.max(0, lower - 10), Math.min(255, upper + 20)] : [lower, upper];
}

function medianIntensity(cv: CV, scope: MatScope, image: Mat): number {
  const hist = scope.keep(new cv.Mat());
  const source = new cv.MatVector();
  const mask = scope.keep(new cv.Mat());
  try {
    source.push_back(image);
    cv.calcHist(source, [0], mask, hist, [256], [0, 256]);

    const total = image.rows * image.cols;
    let cumulative = 0;
    for (let value = 0; value < 256; value += 1) {
      cumulative += hist.floatAt(value, 0);
      if (cumulative >= total / 2) return value;
    }
    return 128;
  } finally {
    source.delete();
  }
}

// --- geometry -------------------------------------------------------------

function matToPoints(mat: Mat): Point[] {
  const points: Point[] = [];
  for (let row = 0; row < mat.rows; row += 1) {
    points.push({ x: mat.intAt(row, 0), y: mat.intAt(row, 1) });
  }
  return points;
}

/**
 * Orders four points as top-left, top-right, bottom-right, bottom-left.
 *
 * `x + y` is smallest at the top-left corner and largest at the bottom-right;
 * `y - x` separates the other two. This holds for any rotation up to ±45°,
 * which covers every hand-held photo — beyond that the user rotates manually.
 */
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) throw new Error(`Expected 4 corners, got ${points.length}`);
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0]!, byDiff[0]!, bySum[3]!, byDiff[3]!];
}

/**
 * True when every one of `points` lies inside `quad`, after growing the quad by
 * `tolerance` to forgive rounding on the boundary itself.
 */
function quadContainsAll(quad: Quad, points: Point[], tolerance: number): boolean {
  const generous = expandQuad(quad, tolerance);
  return points.every((point) => pointInPolygon(generous, point));
}

/** Standard ray-casting point-in-polygon test. */
function pointInPolygon(polygon: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const straddles = a.y > point.y !== b.y > point.y;
    if (!straddles) continue;
    const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (point.x < crossingX) inside = !inside;
  }
  return inside;
}

/** Grows a quad outward from its centroid by `margin` (0.04 = 4 %). */
function expandQuad(quad: Quad, margin: number): Quad {
  const centreX = quad.reduce((sum, point) => sum + point.x, 0) / quad.length;
  const centreY = quad.reduce((sum, point) => sum + point.y, 0) / quad.length;
  const factor = 1 + margin;
  return quad.map((point) => ({
    x: centreX + (point.x - centreX) * factor,
    y: centreY + (point.y - centreY) * factor,
  })) as Quad;
}

/** Shoelace formula. */
function polygonArea(quad: Quad): number {
  let sum = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index]!;
    const next = quad[(index + 1) % quad.length]!;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

/** Rejects slivers: no side may be under 10 % of the longest one. */
function hasSaneAspect(quad: Quad): boolean {
  const lengths = quad.map((point, index) => distance(point, quad[(index + 1) % quad.length]!));
  const longest = Math.max(...lengths);
  const shortest = Math.min(...lengths);
  return longest > 0 && shortest / longest > 0.1;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --- warp and enhance -----------------------------------------------------

export interface EnhanceOutcome {
  /** RGBA Mat, owned by the caller. */
  output: Mat;
  notes: string[];
}

/**
 * Warps `source` onto the given corners and applies the chosen finish.
 * The returned Mat is the caller's to delete.
 */
export function warpAndEnhance(
  cv: CV,
  source: Mat,
  corners: Quad | null,
  options: PipelineOptions,
): EnhanceOutcome {
  const scope = new MatScope();
  const notes: string[] = [];
  try {
    const warped = corners
      ? scope.keep(fourPointTransform(cv, source, corners, options.maxDimension))
      : scope.keep(source.clone());
    if (!corners) notes.push('Ingen kvittokant hittades — hela bilden användes.');

    const resized = scope.keep(resizeToFit(cv, warped, options.maxDimension));
    const rotated = scope.keep(applyRotation(cv, resized, options.rotate));

    if (rotated.cols > rotated.rows * 1.25) {
      notes.push('Bilden är bredare än den är hög — kvittot ligger troligen på sidan.');
    }

    // Hand ownership of the result to the caller, so the scope's cleanup below
    // frees every intermediate but leaves the returned Mat alive.
    const enhanced = scope.detach(enhanceMat(cv, scope, rotated, options.enhance));
    return { output: enhanced, notes };
  } finally {
    scope.dispose();
  }
}

/**
 * Classic four-point perspective correction.
 *
 * The output size comes from the longest opposing edges rather than a fixed
 * aspect ratio, which keeps a receipt photographed at an angle from being
 * squashed: the far end of a tilted receipt is shorter in the photo, and taking
 * the max recovers its true length.
 */
function fourPointTransform(cv: CV, source: Mat, quad: Quad, maxDimension: number): Mat {
  const [tl, tr, br, bl] = quad;
  const width = Math.round(Math.max(distance(br, bl), distance(tr, tl)));
  const height = Math.round(Math.max(distance(tr, br), distance(tl, bl)));
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);

  // Cubic is the better filter when the warp enlarges, but when the result is
  // about to be downscaled by `resizeToFit` it is wasted work: the INTER_AREA
  // pass that follows is what actually prevents aliasing.
  const willShrink = Math.max(safeWidth, safeHeight) > maxDimension;
  const interpolation = willShrink ? cv.INTER_LINEAR : cv.INTER_CUBIC;

  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    safeWidth - 1, 0,
    safeWidth - 1, safeHeight - 1,
    0, safeHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(from, to);
  const output = new cv.Mat();
  try {
    cv.warpPerspective(
      source,
      output,
      transform,
      new cv.Size(safeWidth, safeHeight),
      interpolation,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    return output;
  } finally {
    from.delete();
    to.delete();
    transform.delete();
  }
}

function resizeToFit(cv: CV, source: Mat, maxDimension: number): Mat {
  const longest = Math.max(source.cols, source.rows);
  if (longest <= maxDimension) return source.clone();

  const scale = maxDimension / longest;
  const output = new cv.Mat();
  cv.resize(
    source,
    output,
    new cv.Size(Math.round(source.cols * scale), Math.round(source.rows * scale)),
    0,
    0,
    // INTER_AREA is the right filter for downscaling: it averages the pixels
    // being merged instead of sampling one, which keeps thin strokes visible.
    cv.INTER_AREA,
  );
  return output;
}

function applyRotation(cv: CV, source: Mat, degrees: 0 | 90 | 180 | 270): Mat {
  if (degrees === 0) return source.clone();
  const output = new cv.Mat();
  const code =
    degrees === 90
      ? cv.ROTATE_90_CLOCKWISE
      : degrees === 180
        ? cv.ROTATE_180
        : cv.ROTATE_90_COUNTERCLOCKWISE;
  cv.rotate(source, output, code);
  return output;
}

/** Applies the tonal finish. Returns a new RGBA Mat registered in `scope`. */
function enhanceMat(cv: CV, scope: MatScope, source: Mat, mode: EnhanceMode): Mat {
  if (mode === 'none') return scope.keep(source.clone());

  if (mode === 'color') {
    // Work on the L channel of LAB so colours are untouched while the
    // illumination gradient is removed from the luminance.
    const lab = scope.keep(new cv.Mat());
    cv.cvtColor(source, lab, cv.COLOR_RGBA2RGB);
    cv.cvtColor(lab, lab, cv.COLOR_RGB2Lab);

    const channels = new cv.MatVector();
    try {
      cv.split(lab, channels);
      const lightness = channels.get(0);
      try {
        const flattened = scope.keep(flattenIllumination(cv, scope, lightness));
        applyClahe(cv, scope, flattened, 2.0);
        channels.set(0, flattened);
        cv.merge(channels, lab);
      } finally {
        lightness.delete();
      }
    } finally {
      channels.delete();
    }

    const output = scope.keep(new cv.Mat());
    cv.cvtColor(lab, output, cv.COLOR_Lab2RGB);
    cv.cvtColor(output, output, cv.COLOR_RGB2RGBA);
    return output;
  }

  const gray = scope.keep(new cv.Mat());
  cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);

  const flattened = scope.keep(flattenIllumination(cv, scope, gray));
  applyClahe(cv, scope, flattened, 2.0);

  if (mode === 'binarize') {
    // Block size scales with the image so it always spans a few characters;
    // a fixed block turns large scans into blotches and small ones into noise.
    const block = oddAtLeast(Math.round(Math.max(source.cols, source.rows) / 45), 15);
    cv.adaptiveThreshold(
      flattened,
      flattened,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      block,
      10,
    );
    // Clears the speckle adaptive thresholding leaves in flat paper areas.
    cv.medianBlur(flattened, flattened, 3);
  } else {
    unsharpMask(cv, scope, flattened, 1.4, 0.6);
  }

  const output = scope.keep(new cv.Mat());
  cv.cvtColor(flattened, output, cv.COLOR_GRAY2RGBA);
  return output;
}

/** Long side of the copy the illumination estimate is computed on. */
const BACKGROUND_WORKING_SIZE = 256;

/**
 * Removes the illumination gradient by dividing the image by an estimate of its
 * own background.
 *
 * This is the single biggest quality win for phone photos: it turns a receipt
 * with the user's shadow across one corner into an evenly lit page. A
 * morphological close with a kernel wider than the text erases the print and
 * leaves only the lighting; dividing by that normalises every region to the
 * same paper white.
 *
 * The estimate is computed on a 256 px copy and scaled back up. Illumination is
 * low-frequency by definition, so nothing is lost — but the cost difference is
 * enormous: a close is O(pixels x kernel area), and at full resolution the
 * kernel has to be ~80 px wide, which measured at 7.1 seconds for one receipt
 * against 16 ms for this version.
 */
function flattenIllumination(cv: CV, scope: MatScope, gray: Mat): Mat {
  const scale = Math.min(1, BACKGROUND_WORKING_SIZE / Math.max(gray.cols, gray.rows));
  const small = scope.keep(new cv.Mat());
  if (scale < 1) {
    cv.resize(
      gray,
      small,
      new cv.Size(Math.max(1, Math.round(gray.cols * scale)), Math.max(1, Math.round(gray.rows * scale))),
      0,
      0,
      cv.INTER_AREA,
    );
  } else {
    gray.copyTo(small);
  }

  // Relative to the working copy, not the original — the whole point is that
  // the kernel stays small in absolute pixels.
  const size = oddAtLeast(Math.round(Math.max(small.cols, small.rows) / 12), 9);
  const kernel = scope.keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size)));

  const backgroundSmall = scope.keep(new cv.Mat());
  cv.morphologyEx(small, backgroundSmall, cv.MORPH_CLOSE, kernel);
  // The close leaves blocky steps; smoothing them stops the division from
  // printing the kernel's shape into flat areas of paper.
  cv.GaussianBlur(
    backgroundSmall,
    backgroundSmall,
    new cv.Size(0, 0),
    size / 4,
    size / 4,
    cv.BORDER_REPLICATE,
  );

  const background = scope.keep(new cv.Mat());
  // Cubic, so the upscaled field is smooth rather than faceted.
  cv.resize(backgroundSmall, background, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_CUBIC);

  const output = new cv.Mat();
  cv.divide(gray, background, output, 255, cv.CV_8U);
  return output;
}

/**
 * Applies CLAHE (contrast-limited adaptive histogram equalisation) in place.
 *
 * The API is reached defensively because OpenCV.js builds disagree about it:
 * the stock `opencv.js` exposes the `CLAHE` class but *not* the
 * `createCLAHE()` factory that the C++ and Python APIs use, and calling the
 * missing factory throws — which previously took down the whole pipeline and
 * silently demoted every scan to the canvas fallback.
 *
 * When neither form is available the image still gets a percentile contrast
 * stretch, which is worse than CLAHE but far better than nothing.
 */
function applyClahe(cv: CV, scope: MatScope, gray: Mat, clipLimit: number): void {
  const tiles = new cv.Size(8, 8);
  const api = cv as unknown as {
    createCLAHE?: (clip: number, size: unknown) => { apply: (a: Mat, b: Mat) => void; delete: () => void };
    CLAHE?: new (clip: number, size: unknown) => { apply: (a: Mat, b: Mat) => void; delete: () => void };
  };

  const clahe =
    typeof api.createCLAHE === 'function'
      ? api.createCLAHE(clipLimit, tiles)
      : typeof api.CLAHE === 'function'
        ? new api.CLAHE(clipLimit, tiles)
        : null;

  if (!clahe) {
    stretchContrast(cv, scope, gray);
    return;
  }
  try {
    clahe.apply(gray, gray);
  } finally {
    clahe.delete();
  }
}

/**
 * Rescales intensities so the 2nd..98th percentile spans the full range.
 *
 * Percentiles rather than min/max: one dark speck or a blown highlight would
 * otherwise anchor the range and leave the paper in a narrow band.
 */
function stretchContrast(cv: CV, scope: MatScope, gray: Mat): void {
  const hist = scope.keep(new cv.Mat());
  const source = new cv.MatVector();
  const mask = scope.keep(new cv.Mat());
  try {
    source.push_back(gray);
    cv.calcHist(source, [0], mask, hist, [256], [0, 256]);

    const total = gray.rows * gray.cols;
    let cumulative = 0;
    let low = 0;
    let high = 255;
    for (let value = 0; value < 256; value += 1) {
      cumulative += hist.floatAt(value, 0);
      if (low === 0 && cumulative >= total * 0.02) low = value;
      if (cumulative >= total * 0.98) {
        high = value;
        break;
      }
    }

    const span = Math.max(1, high - low);
    // out = (in - low) * 255 / span
    cv.convertScaleAbs(gray, gray, 255 / span, (-low * 255) / span);
  } finally {
    source.delete();
  }
}

/** Sharpens by subtracting a blurred copy: `out = (1 + a)·img − a·blur`. */
function unsharpMask(cv: CV, scope: MatScope, gray: Mat, sigma: number, amount: number): void {
  const blurred = scope.keep(new cv.Mat());
  cv.GaussianBlur(gray, blurred, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
  cv.addWeighted(gray, 1 + amount, blurred, -amount, 0, gray);
}

function oddAtLeast(value: number, minimum: number): number {
  const clamped = Math.max(minimum, value);
  return clamped % 2 === 0 ? clamped + 1 : clamped;
}
