import { describe, expect, test } from '@jest/globals';

import { createIosNetworkMonitor, type NetworkBackend, type NetworkSnapshot } from '../src/sync/network';
import {
  createIosSyncTriggers,
  type AppLifecycleState,
  type SyncTriggerPolicy,
} from '../src/sync/triggers';

function createFakeNetworkBackend(initial: NetworkSnapshot) {
  let current = initial;
  const listeners = new Set<(snapshot: NetworkSnapshot) => void>();
  return {
    backend: {
      async getState() {
        return current;
      },
      subscribe(listener: (snapshot: NetworkSnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies NetworkBackend,
    emit(next: NetworkSnapshot) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    set(next: NetworkSnapshot) {
      current = next;
    },
  };
}

function createFakeLifecycle(initial: AppLifecycleState = 'active') {
  let current = initial;
  const listeners = new Set<(state: AppLifecycleState) => void>();
  return {
    port: {
      getCurrentState: () => current,
      subscribe(listener: (state: AppLifecycleState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(next: AppLifecycleState) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

function createFakeLocalChanges() {
  const listeners = new Set<() => void>();
  return {
    port: {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Deterministic timers, so debounce and interval behaviour is testable. */
function createFakeTimers(now: () => number) {
  let nextId = 1;
  const timeouts = new Map<number, { at: number; handler: () => void }>();
  const intervals = new Map<number, { every: number; next: number; handler: () => void }>();

  return {
    setTimeoutImpl: (handler: () => void, ms: number) => {
      const id = nextId++;
      timeouts.set(id, { at: now() + ms, handler });
      return id;
    },
    clearTimeoutImpl: (handle: unknown) => {
      timeouts.delete(handle as number);
    },
    setIntervalImpl: (handler: () => void, ms: number) => {
      const id = nextId++;
      intervals.set(id, { every: ms, next: now() + ms, handler });
      return id;
    },
    clearIntervalImpl: (handle: unknown) => {
      intervals.delete(handle as number);
    },
    /** Runs everything due at or before the current clock reading. */
    flush() {
      for (const [id, entry] of [...timeouts]) {
        if (entry.at <= now()) {
          timeouts.delete(id);
          entry.handler();
        }
      }
      for (const entry of intervals.values()) {
        while (entry.next <= now()) {
          entry.next += entry.every;
          entry.handler();
        }
      }
    },
    pendingTimeouts: () => timeouts.size,
    pendingIntervals: () => intervals.size,
  };
}

function setup(policy: () => SyncTriggerPolicy, initial: NetworkSnapshot = { online: true, unmetered: true }) {
  let clock = 100_000;
  const now = () => clock;
  const timers = createFakeTimers(now);
  const network = createFakeNetworkBackend(initial);
  const monitor = createIosNetworkMonitor({ backend: network.backend, initial });
  const lifecycle = createFakeLifecycle('active');
  const localChanges = createFakeLocalChanges();

  const triggers = createIosSyncTriggers({
    lifecycle: lifecycle.port,
    network: monitor,
    localChanges: localChanges.port,
    policy,
    now,
    ...timers,
  });

  const reasons: string[] = [];
  const detach = triggers.attach((reason) => {
    reasons.push(reason);
  });

  return {
    triggers,
    reasons,
    detach,
    monitor,
    network,
    lifecycle,
    localChanges,
    timers,
    advance(ms: number) {
      clock += ms;
    },
  };
}

const ALLOW_ALL: SyncTriggerPolicy = { autoSync: true, wifiOnly: false, ready: true };

describe('automatic sync triggers', () => {
  test('returning to the foreground syncs after re-reading connectivity', async () => {
    const harness = setup(() => ALLOW_ALL);

    harness.lifecycle.emit('background');
    harness.lifecycle.emit('active');
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.reasons).toEqual(['foreground']);
    harness.detach();
  });

  test('regaining a connection while foregrounded syncs, losing one does not', () => {
    const harness = setup(() => ALLOW_ALL, { online: false, unmetered: true });

    harness.network.emit({ online: true, unmetered: true });
    expect(harness.reasons).toEqual(['network-online']);

    harness.advance(60_000);
    harness.network.emit({ online: false, unmetered: true });
    expect(harness.reasons).toEqual(['network-online']);
    harness.detach();
  });

  test('a burst of local edits debounces into one run', () => {
    const harness = setup(() => ALLOW_ALL);

    harness.localChanges.emit();
    harness.localChanges.emit();
    harness.localChanges.emit();
    expect(harness.reasons).toEqual([]);

    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual(['local-change']);
    harness.detach();
  });

  test('automatic sync off, no pairing, offline, and metered connections each suppress a run', () => {
    let policy: SyncTriggerPolicy = { autoSync: false, wifiOnly: false, ready: true };
    const harness = setup(() => policy);

    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual([]);
    expect(harness.triggers.getLastSuppression()).toBe('auto-sync-off');

    policy = { autoSync: true, wifiOnly: false, ready: false };
    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.triggers.getLastSuppression()).toBe('not-configured');

    policy = { autoSync: true, wifiOnly: false, ready: true };
    harness.network.emit({ online: false, unmetered: false });
    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.triggers.getLastSuppression()).toBe('offline');

    policy = { autoSync: true, wifiOnly: true, ready: true };
    harness.network.emit({ online: true, unmetered: false });
    // The connection event itself is a candidate; it is suppressed too.
    expect(harness.triggers.getLastSuppression()).toBe('wifi-only');

    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual([]);
    expect(harness.triggers.getLastSuppression()).toBe('wifi-only');
    harness.detach();
  });

  test('wifi-only still syncs once the device is on an unmetered connection', () => {
    const harness = setup(() => ({ autoSync: true, wifiOnly: true, ready: true }), {
      online: true,
      unmetered: false,
    });

    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual([]);

    harness.network.emit({ online: true, unmetered: true });
    expect(harness.reasons).toEqual(['network-online']);
    harness.detach();
  });

  test('runs are throttled to the minimum interval, except a foreground return', async () => {
    const harness = setup(() => ALLOW_ALL, { online: false, unmetered: true });

    harness.network.emit({ online: true, unmetered: true });
    expect(harness.reasons).toEqual(['network-online']);

    harness.advance(1_000);
    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual(['network-online']);
    expect(harness.triggers.getLastSuppression()).toBe('throttled');

    // A user returning to the app expects fresh data, so that reason bypasses it.
    harness.lifecycle.emit('active');
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.reasons).toEqual(['network-online', 'foreground']);

    harness.advance(20_000);
    harness.localChanges.emit();
    harness.advance(2_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual(['network-online', 'foreground', 'local-change']);
    harness.detach();
  });

  test('the periodic sweep runs only while foregrounded', () => {
    const harness = setup(() => ALLOW_ALL);
    expect(harness.timers.pendingIntervals()).toBe(1);

    harness.advance(300_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual(['interval']);

    harness.lifecycle.emit('background');
    expect(harness.timers.pendingIntervals()).toBe(0);

    harness.advance(300_000);
    harness.timers.flush();
    expect(harness.reasons).toEqual(['interval']);
    harness.detach();
  });

  test('detaching stops every source, including a debounce already in flight', () => {
    const harness = setup(() => ALLOW_ALL);

    harness.localChanges.emit();
    harness.detach();

    harness.advance(5_000);
    harness.timers.flush();
    harness.lifecycle.emit('active');
    harness.network.emit({ online: true, unmetered: true });

    expect(harness.reasons).toEqual([]);
    expect(harness.timers.pendingTimeouts()).toBe(0);
    expect(harness.timers.pendingIntervals()).toBe(0);
  });
});

describe('network monitor', () => {
  test('caches connectivity for the synchronous port and publishes transitions', async () => {
    const network = createFakeNetworkBackend({ online: false, unmetered: false });
    const monitor = createIosNetworkMonitor({
      backend: network.backend,
      initial: { online: false, unmetered: false },
    });

    const seen: NetworkSnapshot[] = [];
    monitor.subscribe((snapshot) => seen.push(snapshot));

    expect(monitor.isOnline()).toBe(false);

    network.emit({ online: true, unmetered: false });
    expect(monitor.isOnline()).toBe(true);
    expect(monitor.isUnmetered()).toBe(false);

    // Repeating the same state is not a transition.
    network.emit({ online: true, unmetered: false });
    expect(seen).toHaveLength(1);

    network.set({ online: true, unmetered: true });
    await monitor.refresh();
    expect(monitor.isUnmetered()).toBe(true);
    expect(seen).toHaveLength(2);

    monitor.dispose();
    network.emit({ online: false, unmetered: false });
    expect(monitor.isOnline()).toBe(true);
  });

  test('a failed reading keeps the last known state', async () => {
    const monitor = createIosNetworkMonitor({
      backend: {
        async getState(): Promise<NetworkSnapshot> {
          throw new Error('radio unavailable');
        },
        subscribe: () => () => {},
      },
      initial: { online: true, unmetered: true },
    });

    await expect(monitor.refresh()).resolves.toEqual({ online: true, unmetered: true });
    expect(monitor.isOnline()).toBe(true);
    monitor.dispose();
  });
});
