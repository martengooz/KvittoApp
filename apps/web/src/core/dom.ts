/**
 * A very small DOM helper layer.
 *
 * The app has no framework on purpose, so this file is the whole rendering
 * abstraction: `el()` builds elements, and views return elements. Everything
 * else is plain DOM.
 *
 * `el()` itself, along with `Child` and `ElementProps`, lives in
 * `packages/shared/src/dom.ts` — the server dashboard's inline browser
 * script needs the identical, dependency-free factory, served as a raw ES
 * module. This file re-exports it and adds the extras that are specific to
 * the web app and have no reason to be servable on their own.
 */

import { append, el, type Child, type ElementProps } from '@kvitto/shared';

export { el, type Child, type ElementProps };

/** Same as {@link el} but for SVG, which needs the namespaced constructor. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  append(node, children);
  return node;
}

/** Removes every child of `node`. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replaces the contents of `node` with `children`. */
export function replaceChildren(node: Element, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

/**
 * Appends children to `node`, skipping nullish ones.
 *
 * Unlike the DOM's own `append`, this accepts the `cond ? node : null` pattern
 * used throughout the views for conditional content.
 */
export function appendChildren(node: Element, ...children: Child[]): void {
  append(node, children);
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`No element matches "${selector}"`);
  return found;
}

/** Debounces `fn`, useful for search-as-you-type inputs. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Yields to the browser so a spinner can paint before heavy work starts. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Runs `swap` — typically a `replaceChildren` that rebuilds a whole subtree —
 * without losing focus.
 *
 * A full re-render tears down and rebuilds every input, so the browser drops
 * focus and, with it, an in-progress text selection: fatal for a search field
 * being typed into while a `data:changed` event happens to land. An element
 * that needs to survive a swap marks itself with `data-focus-key`
 * (`searchField()` does); if the currently focused element carries one and
 * sits inside `root`, this finds its replacement by the same key afterwards
 * and restores focus and the caret.
 */
export function preserveFocus(root: Element, swap: () => void): void {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && root.contains(active) ? active : null;
  const key = focused?.dataset.focusKey;
  const selectionStart = isTextInput(focused) ? focused.selectionStart : null;
  const selectionEnd = isTextInput(focused) ? focused.selectionEnd : null;

  swap();

  if (!key) return;
  const restored = root.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
  if (!restored) return;
  restored.focus({ preventScroll: true });
  if (isTextInput(restored) && selectionStart !== null && selectionEnd !== null) {
    restored.setSelectionRange(selectionStart, selectionEnd);
  }
}

function isTextInput(node: unknown): node is HTMLInputElement | HTMLTextAreaElement {
  return node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
}
