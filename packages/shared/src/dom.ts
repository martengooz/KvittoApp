/**
 * A very small DOM element factory.
 *
 * It lives here, not in the web app, because the server dashboard's inline
 * browser script needs the exact same building block: `ai-settings-ui.ts`
 * and `ui-rows.ts` are served to the browser as raw, unbundled ES modules
 * (see `apps/server/src/dashboard.ts`), so this file must stay dependency-free
 * and import nothing — no Node APIs, no bare specifiers, not even another
 * package. `apps/web/src/core/dom.ts` re-exports `el` for the app's views and
 * adds the web-only extras (focus preservation, debouncing, `qs`, …) that
 * have no reason to be servable on their own.
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

/**
 * Appends `children` to `node`, flattening arrays and skipping nullish or
 * `false` entries — the `cond ? node : null` pattern used throughout the
 * views for conditional content. Exported so the web app's own `clear` /
 * `replaceChildren` / `appendChildren` / `svg` extras, and `ui-rows.ts`, can
 * build on the same flattening rule instead of restating it.
 */
export function append(node: Node, children: Child[]): void {
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
