/**
 * Hash-based router.
 *
 * Hash routing rather than the History API on purpose: the app is served as a
 * static PWA and may live under a sub-path or be opened from a `file://`-like
 * context in a wrapper. Hash routes work in all of those with no server
 * rewrites, and the service worker never has to guess which paths are routes.
 */

import { describeError } from '@kvitto/shared';

export interface RouteContext {
  /** Path segments after the `#/`, e.g. `['receipt', 'abc-123']`. */
  segments: string[];
  params: URLSearchParams;
  path: string;
}

export type ViewFactory = (context: RouteContext) => Promise<HTMLElement> | HTMLElement;

interface Route {
  /** Pattern segments; `:name` captures, `*` matches the rest. */
  pattern: string[];
  factory: ViewFactory;
}

/** Cleanup callbacks the outgoing view registered. */
type Teardown = () => void;

export class Router {
  readonly #routes: Route[] = [];
  #fallback: ViewFactory | null = null;
  #outlet: HTMLElement | null = null;
  #teardowns: Teardown[] = [];
  #currentPath = '';
  /** Guards against an out-of-order render when navigation happens mid-await. */
  #navigationToken = 0;

  add(pattern: string, factory: ViewFactory): this {
    this.#routes.push({ pattern: splitPath(pattern), factory });
    return this;
  }

  fallback(factory: ViewFactory): this {
    this.#fallback = factory;
    return this;
  }

  /** Registers a callback to run when the current view is replaced. */
  onTeardown(callback: Teardown): void {
    this.#teardowns.push(callback);
  }

  start(outlet: HTMLElement): void {
    this.#outlet = outlet;
    window.addEventListener('hashchange', () => void this.render());
    void this.render();
  }

  get currentPath(): string {
    return this.#currentPath;
  }

  navigate(path: string, options: { replace?: boolean } = {}): void {
    const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`;
    if (options.replace) {
      history.replaceState(null, '', target);
      void this.render();
    } else {
      location.hash = target;
    }
  }

  async render(): Promise<void> {
    const outlet = this.#outlet;
    if (!outlet) return;

    const token = ++this.#navigationToken;
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, queryPart] = raw.split('?');
    const segments = splitPath(pathPart ?? '/');
    const params = new URLSearchParams(queryPart ?? '');
    this.#currentPath = pathPart ?? '/';

    const match = this.#match(segments);
    const context: RouteContext = { segments, params, path: this.#currentPath };

    for (const teardown of this.#teardowns) {
      try {
        teardown();
      } catch (error) {
        console.error('View teardown threw', error);
      }
    }
    this.#teardowns = [];

    let view: HTMLElement;
    try {
      const factory = match ?? this.#fallback;
      if (!factory) return;
      view = await factory(context);
    } catch (error) {
      console.error('View failed to render', error);
      view = renderError(error);
    }

    // A newer navigation started while this view was loading; discard this one.
    if (token !== this.#navigationToken) return;

    outlet.replaceChildren(view);
    // Route changes are a new "page": start at the top, as a browser would.
    outlet.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }

  #match(segments: string[]): ViewFactory | null {
    for (const route of this.#routes) {
      if (matches(route.pattern, segments)) return route.factory;
    }
    return null;
  }
}

function matches(pattern: string[], segments: string[]): boolean {
  if (pattern.at(-1) === '*') {
    return pattern.length - 1 <= segments.length && pattern.slice(0, -1).every(
      (part, index) => part.startsWith(':') || part === segments[index],
    );
  }
  if (pattern.length !== segments.length) return false;
  return pattern.every((part, index) => part.startsWith(':') || part === segments[index]);
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function renderError(error: unknown): HTMLElement {
  const container = document.createElement('div');
  container.className = 'view-error';
  const heading = document.createElement('h2');
  heading.textContent = 'Något gick fel';
  const message = document.createElement('p');
  message.textContent = describeError(error);
  container.append(heading, message);
  return container;
}

export const router = new Router();
