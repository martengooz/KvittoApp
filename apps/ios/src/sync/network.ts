import type { NetworkPort } from '@kvitto/client-core/ports';

export interface NetworkSnapshot {
  online: boolean;
  /** True only for connections that do not spend the user's mobile data. */
  unmetered: boolean;
}

/** The slice of `expo-network` this monitor needs, so tests can drive it. */
export interface NetworkBackend {
  getState(): Promise<NetworkSnapshot>;
  subscribe(listener: (snapshot: NetworkSnapshot) => void): () => void;
}

export interface IosNetworkMonitor extends NetworkPort {
  isOnline(): boolean;
  isUnmetered(): boolean;
  getSnapshot(): NetworkSnapshot;
  /** Re-reads the backend and publishes the result. */
  refresh(): Promise<NetworkSnapshot>;
  subscribe(listener: (snapshot: NetworkSnapshot) => void): () => void;
  dispose(): void;
}

export interface CreateIosNetworkMonitorInput {
  backend: NetworkBackend;
  /** Assumed state until the first backend reading arrives. */
  initial?: NetworkSnapshot;
}

const OPTIMISTIC: NetworkSnapshot = { online: true, unmetered: true };

function sameSnapshot(a: NetworkSnapshot, b: NetworkSnapshot): boolean {
  return a.online === b.online && a.unmetered === b.unmetered;
}

/**
 * Caches the device's connectivity so `NetworkPort.isOnline()` can stay
 * synchronous, and publishes transitions so sync can run the moment the device
 * comes back online.
 */
export function createIosNetworkMonitor(input: CreateIosNetworkMonitorInput): IosNetworkMonitor {
  let snapshot = input.initial ?? OPTIMISTIC;
  let disposed = false;
  const listeners = new Set<(snapshot: NetworkSnapshot) => void>();

  function publish(next: NetworkSnapshot): void {
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener(snapshot);
  }

  const detach = input.backend.subscribe((next) => {
    if (disposed) return;
    publish(next);
  });

  return {
    isOnline: () => snapshot.online,
    isUnmetered: () => snapshot.unmetered,
    getSnapshot: () => ({ ...snapshot }),

    async refresh(): Promise<NetworkSnapshot> {
      if (disposed) return { ...snapshot };
      try {
        publish(await input.backend.getState());
      } catch {
        // A failed reading keeps the last known state; sync surfaces real
        // connection failures on its own.
      }
      return { ...snapshot };
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      detach();
      listeners.clear();
    },
  };
}

/** Wraps `expo-network`, loaded lazily so host tests never touch the native module. */
export function createExpoNetworkBackend(): NetworkBackend {
  type ExpoNetworkState = { isConnected?: boolean; isInternetReachable?: boolean; type?: string };
  type ExpoNetworkModule = {
    getNetworkStateAsync(): Promise<ExpoNetworkState>;
    addNetworkStateListener(listener: (event: ExpoNetworkState) => void): { remove(): void };
  };

  const toSnapshot = (state: ExpoNetworkState): NetworkSnapshot => ({
    online: state.isInternetReachable ?? state.isConnected ?? false,
    unmetered: state.type === 'WIFI' || state.type === 'ETHERNET',
  });

  return {
    async getState(): Promise<NetworkSnapshot> {
      const network = (await import('expo-network')) as unknown as ExpoNetworkModule;
      return toSnapshot(await network.getNetworkStateAsync());
    },
    subscribe(listener): () => void {
      let subscription: { remove(): void } | null = null;
      let cancelled = false;

      void import('expo-network').then((module) => {
        if (cancelled) return;
        subscription = (module as unknown as ExpoNetworkModule).addNetworkStateListener((event) => {
          listener(toSnapshot(event));
        });
      });

      return () => {
        cancelled = true;
        subscription?.remove();
      };
    },
  };
}
