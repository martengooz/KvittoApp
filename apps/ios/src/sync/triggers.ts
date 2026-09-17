import type { SyncTriggerAdapter } from './engine';
import type { IosNetworkMonitor } from './network';

export type SyncTriggerReason = 'foreground' | 'network-online' | 'local-change' | 'interval';

export type AppLifecycleState = 'active' | 'background' | 'inactive';

/** The slice of React Native's `AppState` the triggers need. */
export interface AppLifecyclePort {
  getCurrentState(): AppLifecycleState;
  subscribe(listener: (state: AppLifecycleState) => void): () => void;
}

/** Repository change notifications, narrowed to what the triggers care about. */
export interface LocalChangePort {
  subscribe(listener: () => void): () => void;
}

export interface SyncTriggerPolicy {
  /** Automatic sync is switched off entirely in settings. */
  autoSync: boolean;
  /** Only sync on Wi-Fi/Ethernet. */
  wifiOnly: boolean;
  /** No server URL or no pairing token means there is nothing to sync with. */
  ready: boolean;
}

export interface CreateSyncTriggersInput {
  lifecycle: AppLifecyclePort;
  network: IosNetworkMonitor;
  localChanges: LocalChangePort;
  /** Read fresh on every candidate trigger, so settings changes take effect at once. */
  policy: () => SyncTriggerPolicy;
  /** Debounce for bursts of local edits. Default 2s. */
  localChangeDelayMs?: number;
  /** Periodic sweep while the app is foregrounded. Default 5min. 0 disables it. */
  intervalMs?: number;
  /** Floor between two automatic runs, whatever the reason. Default 15s. */
  minIntervalMs?: number;
  now?: () => number;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}

export interface IosSyncTriggers extends SyncTriggerAdapter {
  /** Last reason that was allowed through, for diagnostics and tests. */
  getLastReason(): SyncTriggerReason | null;
  /** Why the most recent candidate was suppressed, if it was. */
  getLastSuppression(): string | null;
}

/**
 * Turns app lifecycle, connectivity, and local edits into sync runs, subject to
 * the user's automatic-sync and Wi-Fi-only settings.
 *
 * A foreground return or a regained connection fires immediately; local edits
 * are debounced so a burst of typing produces one run; and every reason shares
 * one minimum interval so the triggers cannot stack up on each other. The engine
 * coalesces overlapping runs on its own, so a trigger during a run is harmless.
 */
export function createIosSyncTriggers(input: CreateSyncTriggersInput): IosSyncTriggers {
  const now = input.now ?? (() => Date.now());
  const localChangeDelayMs = input.localChangeDelayMs ?? 2_000;
  const intervalMs = input.intervalMs ?? 300_000;
  const minIntervalMs = input.minIntervalMs ?? 15_000;

  const setTimeoutImpl = input.setTimeoutImpl ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutImpl = input.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setIntervalImpl = input.setIntervalImpl ?? ((handler, ms) => setInterval(handler, ms));
  const clearIntervalImpl = input.clearIntervalImpl ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  let lastReason: SyncTriggerReason | null = null;
  let lastSuppression: string | null = null;
  let lastRunAt: number | null = null;

  function suppressionFor(reason: SyncTriggerReason): string | null {
    const policy = input.policy();
    if (!policy.autoSync) return 'auto-sync-off';
    if (!policy.ready) return 'not-configured';
    if (!input.network.isOnline()) return 'offline';
    if (policy.wifiOnly && !input.network.isUnmetered()) return 'wifi-only';
    if (lastRunAt !== null && now() - lastRunAt < minIntervalMs && reason !== 'foreground') {
      return 'throttled';
    }
    return null;
  }

  return {
    getLastReason: () => lastReason,
    getLastSuppression: () => lastSuppression,

    attach(trigger: (reason: string) => void): () => void {
      let disposed = false;
      let localChangeHandle: unknown = null;
      let intervalHandle: unknown = null;

      const fire = (reason: SyncTriggerReason): void => {
        if (disposed) return;
        const suppression = suppressionFor(reason);
        if (suppression) {
          lastSuppression = suppression;
          return;
        }
        lastSuppression = null;
        lastReason = reason;
        lastRunAt = now();
        trigger(reason);
      };

      const stopInterval = (): void => {
        if (intervalHandle === null) return;
        clearIntervalImpl(intervalHandle);
        intervalHandle = null;
      };

      const startInterval = (): void => {
        if (intervalMs <= 0 || intervalHandle !== null) return;
        intervalHandle = setIntervalImpl(() => {
          fire('interval');
        }, intervalMs);
      };

      const detachLifecycle = input.lifecycle.subscribe((state) => {
        if (state === 'active') {
          // Connectivity can change while backgrounded without an event
          // reaching us, so re-read it before deciding whether to sync.
          void input.network.refresh().then(() => {
            fire('foreground');
          });
          startInterval();
          return;
        }
        stopInterval();
      });

      const detachNetwork = input.network.subscribe((snapshot) => {
        if (!snapshot.online) return;
        if (input.lifecycle.getCurrentState() !== 'active') return;
        fire('network-online');
      });

      const detachLocalChanges = input.localChanges.subscribe(() => {
        if (disposed) return;
        if (localChangeHandle !== null) clearTimeoutImpl(localChangeHandle);
        localChangeHandle = setTimeoutImpl(() => {
          localChangeHandle = null;
          fire('local-change');
        }, localChangeDelayMs);
      });

      if (input.lifecycle.getCurrentState() === 'active') startInterval();

      return () => {
        if (disposed) return;
        disposed = true;
        detachLifecycle();
        detachNetwork();
        detachLocalChanges();
        if (localChangeHandle !== null) clearTimeoutImpl(localChangeHandle);
        stopInterval();
      };
    },
  };
}

/** Wraps React Native's `AppState`, loaded lazily to keep host tests native-free. */
export function createReactNativeAppLifecycle(): AppLifecyclePort {
  type AppStateModule = {
    currentState: string;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };

  const normalize = (state: string): AppLifecycleState =>
    state === 'active' ? 'active' : state === 'background' ? 'background' : 'inactive';

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const appState = (require('react-native') as { AppState: AppStateModule }).AppState;

  return {
    getCurrentState: () => normalize(appState.currentState),
    subscribe(listener): () => void {
      const subscription = appState.addEventListener('change', (state) => {
        listener(normalize(state));
      });
      return () => {
        subscription.remove();
      };
    },
  };
}
