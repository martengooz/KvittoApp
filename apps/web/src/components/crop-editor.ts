/**
 * Four-corner crop editor.
 *
 * Automatic detection gets the outline right most of the time; this is for the
 * rest — a receipt on a patterned table, one folded at the end, or a photo with
 * a second receipt in frame. Corners are dragged with a pointer or a finger,
 * and the handles are offset-tracked so the corner does not jump to the centre
 * of the fingertip on the first move.
 */

import { el, svg } from '../core/dom.js';
import type { Point, Quad } from '../cv/types.js';

export interface CropEditorOptions {
  /** Displayed image. Must already be decoded. */
  imageUrl: string;
  /** Natural pixel size of the image the corners are expressed in. */
  naturalWidth: number;
  naturalHeight: number;
  /** Starting corners. Defaults to a small inset of the whole frame. */
  corners?: Quad | null;
  onChange?: (corners: Quad) => void;
}

export interface CropEditor {
  element: HTMLElement;
  getCorners: () => Quad;
  setCorners: (corners: Quad) => void;
  /** Expands the selection back to the full image. */
  reset: () => void;
  destroy: () => void;
}

/** Radius of the draggable handles, in image pixels — scaled to stay tappable. */
function handleRadius(width: number, height: number): number {
  return Math.max(14, Math.round(Math.max(width, height) / 45));
}

export function createCropEditor(options: CropEditorOptions): CropEditor {
  const { naturalWidth: width, naturalHeight: height } = options;
  const radius = handleRadius(width, height);

  let corners: Quad = options.corners ? clone(options.corners) : defaultQuad(width, height);

  const outline = svg('polygon', { class: 'crop-outline', points: pointsAttr(corners) });
  const handles = corners.map((corner, index) =>
    svg('circle', {
      class: 'crop-handle',
      cx: corner.x,
      cy: corner.y,
      r: radius,
      'data-index': index,
      role: 'slider',
      tabindex: 0,
      'aria-label': CORNER_LABELS[index] ?? `Hörn ${index + 1}`,
    }),
  );

  const overlay = svg(
    'svg',
    {
      class: 'crop-overlay',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'xMidYMid meet',
    },
    outline,
    ...handles,
  );

  const image = el('img', {
    src: options.imageUrl,
    alt: 'Skannat kvitto, dra i hörnen för att justera beskärningen',
    decoding: 'async',
  });

  const stage = el('div', { class: 'crop-stage' }, image, overlay);

  let activeIndex: number | null = null;
  let grabOffset: Point = { x: 0, y: 0 };

  function toImageSpace(event: PointerEvent): Point {
    const rect = overlay.getBoundingClientRect();
    // The SVG letterboxes when the container is not exactly the image aspect,
    // so map through the rendered box rather than assuming a 1:1 fit.
    const scale = Math.min(rect.width / width, rect.height / height) || 1;
    const offsetX = (rect.width - width * scale) / 2;
    const offsetY = (rect.height - height * scale) / 2;
    return {
      x: (event.clientX - rect.left - offsetX) / scale,
      y: (event.clientY - rect.top - offsetY) / scale,
    };
  }

  function redraw(): void {
    outline.setAttribute('points', pointsAttr(corners));
    corners.forEach((corner, index) => {
      const handle = handles[index];
      if (!handle) return;
      handle.setAttribute('cx', String(corner.x));
      handle.setAttribute('cy', String(corner.y));
    });
  }

  function commit(): void {
    redraw();
    options.onChange?.(clone(corners));
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as SVGElement;
    const raw = target.dataset?.['index'];
    const index = raw === undefined ? nearestCorner(corners, toImageSpace(event), radius * 2.2) : Number(raw);
    if (index === null || Number.isNaN(index)) return;

    activeIndex = index;
    const corner = corners[index]!;
    const pointer = toImageSpace(event);
    // Remember where inside the handle the finger landed, so the corner tracks
    // the finger's motion instead of snapping under its centre.
    grabOffset = { x: corner.x - pointer.x, y: corner.y - pointer.y };

    handles[index]?.classList.add('crop-handle--active');
    overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (activeIndex === null) return;
    const pointer = toImageSpace(event);
    corners[activeIndex] = {
      x: clamp(pointer.x + grabOffset.x, 0, width),
      y: clamp(pointer.y + grabOffset.y, 0, height),
    };
    redraw();
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    if (activeIndex === null) return;
    handles[activeIndex]?.classList.remove('crop-handle--active');
    activeIndex = null;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    commit();
  }

  /** Arrow keys nudge the focused corner, for precision and for accessibility. */
  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as SVGElement;
    const raw = target.dataset?.['index'];
    if (raw === undefined) return;
    const index = Number(raw);
    const corner = corners[index];
    if (!corner) return;

    const step = event.shiftKey ? 20 : 4;
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const move = delta[event.key];
    if (!move) return;

    corners[index] = {
      x: clamp(corner.x + move.x, 0, width),
      y: clamp(corner.y + move.y, 0, height),
    };
    commit();
    event.preventDefault();
  }

  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerUp);
  overlay.addEventListener('keydown', onKeyDown);

  return {
    element: stage,
    getCorners: () => clone(corners),
    setCorners: (next) => {
      corners = clone(next);
      redraw();
    },
    reset: () => {
      corners = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ];
      commit();
    },
    destroy: () => {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.removeEventListener('pointercancel', onPointerUp);
      overlay.removeEventListener('keydown', onKeyDown);
    },
  };
}

const CORNER_LABELS = ['Övre vänstra hörnet', 'Övre högra hörnet', 'Nedre högra hörnet', 'Nedre vänstra hörnet'];

function defaultQuad(width: number, height: number): Quad {
  const insetX = width * 0.08;
  const insetY = height * 0.06;
  return [
    { x: insetX, y: insetY },
    { x: width - insetX, y: insetY },
    { x: width - insetX, y: height - insetY },
    { x: insetX, y: height - insetY },
  ];
}

function pointsAttr(quad: Quad): string {
  return quad.map((point) => `${point.x},${point.y}`).join(' ');
}

function clone(quad: Quad): Quad {
  return quad.map((point) => ({ x: point.x, y: point.y })) as Quad;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Index of the corner within `tolerance` of `point`, or `null`. */
function nearestCorner(quad: Quad, point: Point, tolerance: number): number | null {
  let best: { index: number; distance: number } | null = null;
  quad.forEach((corner, index) => {
    const distance = Math.hypot(corner.x - point.x, corner.y - point.y);
    if (distance <= tolerance && (!best || distance < best.distance)) best = { index, distance };
  });
  return best === null ? null : (best as { index: number }).index;
}
