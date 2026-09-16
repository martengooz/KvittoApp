/**
 * The arithmetic behind swipe-to-delete, kept apart from the DOM that uses it.
 *
 * `swipe-actions.ts` owns the pointer plumbing — capture, listeners, transforms
 * — and this file owns the decisions that plumbing has to make: whether a drag
 * is a swipe at all, how far the row may follow the finger, and what letting go
 * at that point means. Those are the parts worth pinning down in a test, and a
 * module with no imports can be tested without a browser — the same split
 * `scan/import-toast.ts` uses.
 *
 * Offsets are the row's own translation: 0 closed, negative once dragged left.
 */

/** Finger travel, in CSS pixels, before a touch counts as a swipe and not a tap. */
export const SWIPE_SLOP = 10;

/**
 * How far past closed the row may be pulled the wrong way before it stops
 * following the finger, and how much of that pull lands on screen. A rightward
 * tug on a closed row is not a gesture, just something to acknowledge.
 */
const RUBBER_BAND = 24;
const RUBBER_BAND_RESISTANCE = 0.25;

/** Share of the row's width a swipe must cross to fire the action on release. */
const FULL_SWIPE_RATIO = 0.55;

/** Share of the action's width the row must clear to stay open on release. */
const OPEN_RATIO = 0.5;

export interface SwipeGeometry {
  /** Width of the whole row, which a full swipe has to cross. */
  rowWidth: number;
  /** Width of the revealed action, which is where an open row rests. */
  actionWidth: number;
}

/**
 * Where the row should sit for a given raw offset.
 *
 * Leftwards it tracks the finger as far as the row is wide, because a full
 * swipe carries the row off its own edge. Rightwards — past closed — it goes
 * slack, so pulling the wrong way feels like resistance rather than nothing.
 */
export function clampOffset(offset: number, geometry: SwipeGeometry): number {
  if (offset > 0) return Math.min(offset * RUBBER_BAND_RESISTANCE, RUBBER_BAND);
  return Math.max(offset, -geometry.rowWidth);
}

export type SwipeOutcome = 'closed' | 'open' | 'action';

/**
 * What letting go at `offset` means.
 *
 * Three states, the ones iOS Mail has: release early and the row springs back,
 * release past half the action and it stays open with the action showing, and
 * carry it across most of the row and the action fires outright.
 */
export function resolveSwipe(offset: number, geometry: SwipeGeometry): SwipeOutcome {
  const travel = -offset;
  if (travel >= geometry.rowWidth * FULL_SWIPE_RATIO) return 'action';
  if (travel >= geometry.actionWidth * OPEN_RATIO) return 'open';
  return 'closed';
}

/**
 * Whether a drag is horizontal enough to be a swipe rather than the page
 * scrolling underneath it.
 *
 * Undecided until one axis clears the slop, so a finger that has barely moved
 * commits the gesture neither way — and a diagonal drag goes to whichever axis
 * is winning, which is what a list being scrolled past at an angle wants.
 */
export function swipeAxis(dx: number, dy: number): 'horizontal' | 'vertical' | 'undecided' {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (vertical > horizontal && vertical > SWIPE_SLOP) return 'vertical';
  if (horizontal >= vertical && horizontal > SWIPE_SLOP) return 'horizontal';
  return 'undecided';
}
