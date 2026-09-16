/**
 * Swipe-to-delete, the UITableView gesture.
 *
 * A row wrapped in {@link swipeRow} follows the finger leftwards to uncover a
 * red action behind it, rests open once the drag clears that action's width,
 * and — carried most of the way across the row — fires on release without
 * stopping at all. The three states iOS Mail has, and the reason the gesture
 * is here: deleting a receipt in a shop should not cost a trip into the receipt
 * and back out again.
 *
 * The gesture is an accelerator, never the only way in. It is invisible to a
 * screen reader and unreachable from a keyboard, so the uncovered button is
 * `inert` until the row is actually open and every row that has one also keeps
 * its ordinary delete — the trash button in the item editor, "Ta bort kvittot"
 * on the receipt itself.
 *
 * Deletes here are immediate rather than confirmed: an alert in front of a
 * gesture this cheap to trigger would make the gesture pointless, so callers
 * pair the delete with an "Ångra" toast, which is what iOS does too.
 */

import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { haptic } from '../core/platform.js';
import { clampOffset, resolveSwipe, swipeAxis, type SwipeGeometry } from './swipe-gesture.js';

/** Width to assume for the action before the row has ever been laid out. */
const ACTION_WIDTH_FALLBACK = 92;

/**
 * The one row that is currently open, app-wide.
 *
 * iOS never leaves two rows open at once, and neither does this: opening one
 * closes the last, the same way tapping anywhere outside it does.
 */
let openRow: { close: () => void; element: HTMLElement } | null = null;

export interface SwipeRowOptions {
  /** The row as it was before: the card, the editor, whatever is being wrapped. */
  content: HTMLElement;
  /** Accessible name for the uncovered button — "Ta bort kvittot från ICA". */
  label: string;
  /** The word printed on it. */
  actionLabel?: string;
  /** Runs when the button is tapped, or when a full swipe carries the row across. */
  onAction: () => void | Promise<void>;
}

/** Wraps `content` in a row that can be swiped left to reveal a delete. */
export function swipeRow(options: SwipeRowOptions): HTMLElement {
  /** Where the row rests between gestures: 0 closed, `-actionWidth` open. */
  let offset = 0;
  let geometry: SwipeGeometry = { rowWidth: 0, actionWidth: ACTION_WIDTH_FALLBACK };
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  /** Set once a gesture has moved the row, so the tap that ends it is swallowed. */
  let swiped = false;
  let fired = false;

  const button = el(
    'button',
    {
      class: 'swipe-row__action',
      type: 'button',
      'aria-label': options.label,
      tabindex: -1,
      on: { click: () => void fire() },
    },
    icon('trash', { size: 19 }),
    el('span', { text: options.actionLabel ?? 'Ta bort' }),
  );

  const actions = el('div', { class: 'swipe-row__actions' }, button);
  const content = el('div', { class: 'swipe-row__content' }, options.content);
  const root = el('div', { class: 'swipe-row' }, actions, content);
  setReachable(false);

  function setReachable(reachable: boolean): void {
    // `inert` keeps the uncovered button out of the accessibility tree and out
    // of the tab order while it is hidden behind the row; `tabindex` says the
    // same thing again for a browser too old to know the attribute.
    actions.inert = !reachable;
    button.tabIndex = reachable ? 0 : -1;
    root.classList.toggle('swipe-row--open', reachable);
  }

  function measure(): void {
    geometry = {
      rowWidth: root.offsetWidth,
      actionWidth: button.offsetWidth || ACTION_WIDTH_FALLBACK,
    };
  }

  function translate(x: number, settle: boolean): void {
    content.classList.toggle('swipe-row__content--settling', settle);
    content.style.transform = x === 0 ? '' : `translate3d(${x}px, 0, 0)`;
  }

  function open(): void {
    if (openRow && openRow.element !== root) openRow.close();
    openRow = { close: () => close(), element: root };
    offset = -geometry.actionWidth;
    translate(offset, true);
    setReachable(true);
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    haptic('selection');
  }

  function close(settle = true): void {
    if (openRow?.element === root) openRow = null;
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    offset = 0;
    translate(0, settle);
    setReachable(false);
  }

  /** Runs the action once, whichever of the two ways triggered it. */
  async function fire(): Promise<void> {
    if (fired) return;
    fired = true;
    haptic('impact');
    // Carry the row off its own edge: the list is about to re-render without
    // it, and a row that vanishes from under the finger reads as a glitch.
    offset = -geometry.rowWidth;
    translate(offset, true);
    setReachable(false);
    if (openRow?.element === root) openRow = null;
    document.removeEventListener('pointerdown', onOutsidePointerDown, true);
    try {
      await options.onAction();
    } catch (error) {
      // The delete did not happen, so the row has to come back — on the way
      // through, since nothing else is going to re-render it.
      fired = false;
      close();
      throw error;
    }
  }

  function onOutsidePointerDown(event: PointerEvent): void {
    // The row may have been re-rendered away while open, taking its only
    // chance to unregister this listener with it.
    if (!root.isConnected) {
      document.removeEventListener('pointerdown', onOutsidePointerDown, true);
      return;
    }
    if (root.contains(event.target as Node)) return;
    close();
  }

  function onPointerDown(event: PointerEvent): void {
    if (pointerId !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A drag inside the field being edited is the caret being moved, and a
    // native picker swallows the gesture anyway.
    const target = event.target;
    if (target instanceof HTMLSelectElement) return;
    if (target === document.activeElement && isTextField(target)) return;

    measure();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;
    swiped = false;
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragging) {
      const axis = swipeAxis(dx, dy);
      // `touch-action: pan-y` already hands horizontal drags over and keeps
      // vertical ones scrolling; this only decides when to take the row over.
      if (axis === 'vertical') {
        release();
        return;
      }
      if (axis === 'undecided') return;
      dragging = true;
      swiped = true;
      root.classList.add('swipe-row--swiping');
      root.setPointerCapture(event.pointerId);
    }

    translate(clampOffset(offset + dx, geometry), false);
    if (event.cancelable) event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const wasDragging = dragging;
    const resting = clampOffset(offset + (event.clientX - startX), geometry);
    release();
    if (!wasDragging) return;

    const outcome = resolveSwipe(resting, geometry);
    if (outcome === 'action') void fire();
    else if (outcome === 'open') open();
    else close();
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    release();
    translate(offset, true);
  }

  function release(): void {
    if (pointerId !== null && root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
    pointerId = null;
    dragging = false;
    root.classList.remove('swipe-row--swiping');
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerCancel);

  // Captured, so the tap never reaches the card underneath: a swipe that ends
  // on a receipt must not also open that receipt, and a tap on an open row
  // closes it rather than following it.
  root.addEventListener(
    'click',
    (event) => {
      if (actions.contains(event.target as Node)) return;
      // The click a finished drag leaves behind. Swallowed, but it is not a tap
      // on the row — it must not undo the open state the drag just settled on.
      if (swiped) {
        swiped = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (offset === 0) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    true,
  );

  return root;
}

function isTextField(node: unknown): node is HTMLInputElement | HTMLTextAreaElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}
