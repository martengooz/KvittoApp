export interface ExternalStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

export interface WritableExternalStore<T> extends ExternalStore<T> {
  setSnapshot(next: T): void;
}

export function createExternalStore<T>(initial: T): WritableExternalStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot(): T {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSnapshot(next: T): void {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * Shares one in-flight invocation across concurrent callers.
 */
export function createSharedInFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (): Promise<T> => {
    inFlight ??= work().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}