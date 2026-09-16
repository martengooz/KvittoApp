/**
 * When to press the shutter without being asked.
 *
 * The scan screen watches the preview: a few times a second it hands a small
 * copy of the current frame to the document detector, and when the same receipt
 * outline comes back still enough, often enough, it takes the picture — the
 * gesture iOS's own document scanner made everyone expect. This module is the
 * judgement that sits between those two facts, kept free of the DOM and of the
 * clock so it can be tested without either. `scan/session.ts` owns the loop.
 *
 * The hard part is not finding an outline; it is refusing one. The detector
 * always answers, and its own confidence score cannot be used to filter: it is
 * built from how much of the frame the outline covers and how rectangular it
 * is, so a camera pointed at a blank wall scores a perfect 1.0 — higher than
 * any real receipt measured against `fixtures/`, which score 0.57 to 0.99. A
 * shutter wired to that would fire at the ceiling, the desk and the user's
 * hand.
 *
 * So a reading has to clear three hurdles instead, measured on the nine hand-
 * held fixture photographs and on flat controls (wall, wood, skin, noise):
 *
 * 1. **The strategy that found it.** `paper` knows what a receipt is — bright
 *    and colourless — and found all nine fixtures. `threshold` is the last
 *    resort that fires on anything with a bright half, and it is what claimed
 *    the desk, the hand and the noise.
 * 2. **Ink inside the outline.** Paper that has been printed on has a few per
 *    cent of dark pixels; the fixtures measure 0.09 to 0.50, the synthetic
 *    receipts 0.08 and 0.16, and every blank control measures 0.000. This is
 *    the hurdle that separates a receipt filling the frame from a wall filling
 *    the frame, which nothing else can.
 * 3. **Stillness.** The same outline, in the same place, several readings
 *    running — a receipt being held up to be photographed, rather than one
 *    swinging past on the way somewhere else.
 */

import type { DetectionSource, Quad } from '../cv/types.js';

/** Long edge, in pixels, of the frame copy the detector is given. */
export const PROBE_SIZE = 420;

/** Agreeing readings in a row before the shutter fires. */
export const STEADY_READINGS = 3;

/**
 * How far a corner may travel between readings and still count as held still,
 * as a share of the frame's diagonal. Generous enough for the tremor of a hand
 * holding a phone, tight enough that a receipt being moved into place does not
 * qualify on the way.
 */
const STEADY_TOLERANCE = 0.025;

/** Smallest share of the frame an outline may cover and still be a receipt. */
const MIN_COVERAGE = 0.12;

/**
 * The band of ink an outline must carry.
 *
 * The floor is three times under the least-printed fixture and nothing at all
 * reaches it by accident. The ceiling rejects a frame that is mostly dark — a
 * keyboard, a shadowed table — which measures 0.65 in the noise control.
 */
const MIN_INK = 0.03;
const MAX_INK = 0.6;

/** Detection strategies whose answer is worth acting on unasked. */
const TRUSTED: readonly DetectionSource[] = ['paper', 'contour'];

/** What one look at the preview found. */
export interface FrameReading {
  /** The outline, in the coordinates of the frame that was measured. */
  corners: Quad | null;
  detection: DetectionSource;
  /** Share of the frame inside the outline, 0..1. */
  coverage: number;
  /** Share of the outline's own pixels that are printed on, 0..1. */
  ink: number;
  /** Size of the frame this was measured on — the outline's own coordinate space. */
  frameWidth: number;
  frameHeight: number;
}

export interface WatchState {
  /** `holding` once a receipt has been found and has started to sit still. */
  status: 'searching' | 'holding';
  /** Agreeing readings so far. */
  steady: number;
  /** The outline the last reading found, for the next one to be compared to. */
  quad: Quad | null;
}

export interface Verdict {
  state: WatchState;
  /** True on the reading that completes the hold: take the picture now. */
  capture: boolean;
}

export const IDLE_WATCH: WatchState = { status: 'searching', steady: 0, quad: null };

/** Whether an outline is a printed receipt rather than whatever else is in shot. */
export function looksLikeReceipt(reading: FrameReading): boolean {
  if (!reading.corners) return false;
  if (!TRUSTED.includes(reading.detection)) return false;
  if (reading.coverage < MIN_COVERAGE) return false;
  return reading.ink >= MIN_INK && reading.ink <= MAX_INK;
}

/** Whether two outlines are the same receipt, still in the same place. */
export function isSteady(previous: Quad, next: Quad, frame: { width: number; height: number }): boolean {
  const limit = Math.hypot(frame.width, frame.height) * STEADY_TOLERANCE;
  return previous.every((corner, index) => {
    const moved = next[index];
    return moved !== undefined && Math.hypot(corner.x - moved.x, corner.y - moved.y) <= limit;
  });
}

/**
 * Folds one reading into the watch.
 *
 * A reading that is not a receipt drops the count to zero rather than decaying
 * it: the promise the screen makes is "hold it still", and a hold interrupted
 * is not a hold most of the way through.
 */
export function advance(state: WatchState, reading: FrameReading): Verdict {
  if (!looksLikeReceipt(reading) || !reading.corners) {
    return { state: IDLE_WATCH, capture: false };
  }

  const frame = { width: reading.frameWidth, height: reading.frameHeight };
  const held = state.quad !== null && isSteady(state.quad, reading.corners, frame);
  const steady = held ? state.steady + 1 : 1;

  return {
    state: {
      // One agreeing pair is already worth saying something about: it is what
      // turns "point at a receipt" into "keep it there".
      status: steady >= 2 ? 'holding' : 'searching',
      steady,
      quad: reading.corners,
    },
    capture: steady >= STEADY_READINGS,
  };
}

// --- frame measurements ---------------------------------------------------

/** Share of a `width`×`height` frame that lies inside `quad`, 0..1. */
export function coverageOf(quad: Quad, width: number, height: number): number {
  const area = Math.abs(
    quad.reduce((sum, corner, index) => {
      const next = quad[(index + 1) % quad.length]!;
      return sum + (corner.x * next.y - next.x * corner.y);
    }, 0) / 2,
  );
  const frame = width * height;
  return frame > 0 ? Math.min(1, area / frame) : 0;
}

/**
 * Share of the pixels inside `quad` that are printed on.
 *
 * "Printed on" is measured against the paper's own brightness rather than a
 * fixed level, because the same receipt is a different grey in a shop and on a
 * sunlit table: the 90th percentile inside the outline is what the paper is,
 * and anything materially darker than that is ink. Sampled on a stride, so the
 * cost stays near a millisecond however large the outline is.
 */
export function inkRatio(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  quad: Quad,
): number {
  const left = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
  const right = Math.min(width - 1, Math.ceil(Math.max(...quad.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...quad.map((point) => point.y))));
  const stride = Math.max(1, Math.round(Math.max(right - left, bottom - top) / 120));

  const samples: number[] = [];
  for (let y = top; y <= bottom; y += stride) {
    for (let x = left; x <= right; x += stride) {
      if (!insideQuad(quad, x, y)) continue;
      const offset = (y * width + x) * 4;
      samples.push(
        0.299 * (pixels[offset] ?? 0) + 0.587 * (pixels[offset + 1] ?? 0) + 0.114 * (pixels[offset + 2] ?? 0),
      );
    }
  }
  // Too small a sample says nothing; treat it as no ink rather than as ink.
  if (samples.length < 64) return 0;

  const sorted = [...samples].sort((a, b) => a - b);
  const paper = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  if (paper <= 0) return 0;

  const dark = samples.filter((value) => value < paper * 0.72).length;
  return dark / samples.length;
}

/** Whether a point is inside a convex quad, by the sign of its cross products. */
function insideQuad(quad: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const corner = quad[index]!;
    const next = quad[(index + 1) % quad.length]!;
    const cross = (next.x - corner.x) * (y - corner.y) - (next.y - corner.y) * (x - corner.x);
    if (cross === 0) continue;
    const side = cross > 0 ? 1 : -1;
    if (sign === 0) sign = side;
    else if (sign !== side) return false;
  }
  return true;
}
