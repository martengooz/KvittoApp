/** A typed pub/sub bus, used to keep views in step with the data layer. */

export type Unsubscribe = () => void;

export class Emitter<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy first: a listener is allowed to unsubscribe itself while running.
    for (const listener of [...set]) {
      try {
        (listener as (value: Events[K]) => void)(payload);
      } catch (error) {
        console.error(`Listener for "${String(event)}" threw`, error);
      }
    }
  }
}

/** Events broadcast across the whole app. */
export interface AppEvents {
  /**
   * Any receipt, item, tag or category changed.
   *
   * `echo` is set when the change arrived from another tab, so the tab that
   * relays it does not broadcast it straight back.
   */
  'data:changed': { kinds: string[]; echo?: boolean };
  /** Sync state moved. */
  'sync:state': { state: 'idle' | 'syncing' | 'error' | 'offline'; message?: string };
  /** Number of AI provider requests currently in flight. */
  'ai:activity': { pending: number };
  /** Settings were saved. */
  'settings:changed': Record<string, never>;
  /** Network reachability flipped. */
  'net:online': { online: boolean };
}

export const bus = new Emitter<AppEvents>();
