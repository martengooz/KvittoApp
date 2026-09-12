/**
 * A very small DOM helper layer.
 *
 * The app has no framework on purpose, so this file is the whole rendering
 * abstraction: `el()` builds elements, and views return elements. Everything
 * else is plain DOM.
 */

type Falsy = null | undefined | false;
export type Child = Node | string | number | Falsy | Child[];

/** Attributes accepted by {@link el}, beyond the element's own properties. */
export interface ElementProps {
  class?: string | Falsy | (string | Falsy)[];
  text?: string | number;
  html?: string;
  dataset?: Record<string, string | number | boolean | undefined>;
  style?: Partial<CSSStyleDeclaration> | string;
  /** Event listeners, keyed without the `on` prefix: `{ click: handler }`. */
  on?: {
    [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void;
  };
  /** Anything else is set as an attribute, or as a property when one exists. */
  [key: string]: unknown;
}

/**
 * Creates an element.
 *
 * `el('button', { class: 'btn', on: { click } }, 'Spara')`
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) applyProps(node, props);
  append(node, children);
  return node;
}

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

function applyProps(node: HTMLElement, props: ElementProps): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    switch (key) {
      case 'class': {
        const list = Array.isArray(value) ? value : [value];
        const classes = list.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
        if (classes.length) node.className = classes.join(' ');
        break;
      }
      case 'text':
        node.textContent = String(value);
        break;
      case 'html':
        // Only ever called with markup this codebase authored; never user data.
        node.innerHTML = String(value);
        break;
      case 'dataset':
        for (const [dataKey, dataValue] of Object.entries(value as Record<string, unknown>)) {
          if (dataValue === undefined) continue;
          node.dataset[dataKey] = String(dataValue);
        }
        break;
      case 'style':
        if (typeof value === 'string') node.setAttribute('style', value);
        else Object.assign(node.style, value);
        break;
      case 'on':
        for (const [type, handler] of Object.entries(value as Record<string, EventListener>)) {
          node.addEventListener(type, handler);
        }
        break;
      default:
        if (key in node && typeof value !== 'object') {
          (node as unknown as Record<string, unknown>)[key] = value;
        } else {
          node.setAttribute(key, String(value));
        }
    }
  }
}

function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
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
