/**
 * The scaffold every data-driven view needs: load some data, render it, and
 * re-render whenever an event fires that could have changed it — an edit made
 * on this screen, an edit synced in from another tab, an incoming sync pass.
 *
 * A full rebuild would normally cost a search field its focus and caret the
 * moment one of those events lands mid-keystroke, so the swap goes through
 * {@link preserveFocus} rather than a bare `replaceChildren`.
 */

import type { AppEvents } from './events.js';
import { bus } from './events.js';
import { el, preserveFocus, replaceChildren, type Child } from './dom.js';
import { router } from './router.js';

export interface LiveViewOptions<T> {
  /** Events that should trigger a refresh. Defaults to `['data:changed']`. */
  on?: (keyof AppEvents)[];
  load: () => Promise<T>;
  render: (data: T, refresh: () => Promise<void>) => Child | Promise<Child>;
}

export async function liveView<T>(options: LiveViewOptions<T>): Promise<HTMLElement> {
  const root = el('div', {});

  async function refresh(): Promise<void> {
    const data = await options.load();
    const content = await options.render(data, refresh);
    preserveFocus(root, () => replaceChildren(root, content));
  }

  const events = options.on ?? ['data:changed'];
  const unsubscribes = events.map((event) => bus.on(event, () => void refresh()));
  router.onTeardown(() => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  await refresh();
  return root;
}

/** A busy flag paired with the run-and-refresh sequence every long action needs. */
export interface BusyTask {
  readonly busy: boolean;
  /**
   * Runs `action` while `busy` is true, re-rendering before and after via
   * `refresh` so the busy state paints immediately and the outcome shows once
   * it lands. A run already in progress is ignored rather than overlapped.
   */
  run(action: () => Promise<void>, refresh: () => Promise<void>): Promise<void>;
}

/**
 * A named busy flag for one long-running screen action — parsing a receipt,
 * re-reading its image — that used to be tracked with a hand-rolled boolean
 * and a `let refreshScreen = async () => {}` capture to reach the view's own
 * refresh. `refresh` is supplied at call time instead, since a `liveView`
 * render always has it to hand.
 */
export function busyTask(): BusyTask {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run(action, refresh) {
      if (busy) return;
      busy = true;
      await refresh();
      try {
        await action();
      } finally {
        busy = false;
        await refresh();
      }
    },
  };
}
