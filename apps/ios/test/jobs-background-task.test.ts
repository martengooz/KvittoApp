import { describe, expect, test } from '@jest/globals';

import type { NativeBackgroundLaunch } from '../modules/kvitto-native/src/contracts';
import type { BackgroundSweepOptions } from '../src/jobs/background-runner';
import type { BackgroundSweepOutcome } from '../src/jobs/service';
import {
  BACKGROUND_TASK_MARKERS,
  createBackgroundTaskController,
  type BackgroundTaskPort,
} from '../src/jobs/background-task';

function launch(handle: string, startedAt = 1_000): NativeBackgroundLaunch {
  return {
    handle,
    identifier: 'com.kvitto.app.ios.jobs.processing',
    startedAt,
    // Always null from iOS; the controller has to invent a deadline.
    deadlineAt: null,
  };
}

interface FakeNative extends BackgroundTaskPort {
  finished: Array<{ handle: string; success: boolean }>;
  diagnostics: Array<{ category: string; message: string }>;
  scheduleCalls: number;
  expired: Set<string>;
  buffered: NativeBackgroundLaunch[];
  emit(value: NativeBackgroundLaunch): void;
  listeners: number;
}

function makeNative(
  overrides: Partial<Pick<BackgroundTaskPort, 'scheduleBackgroundProcessing'>> = {},
): FakeNative {
  let listener: ((value: NativeBackgroundLaunch) => void) | null = null;

  const native: FakeNative = {
    finished: [],
    diagnostics: [],
    scheduleCalls: 0,
    expired: new Set<string>(),
    buffered: [],
    listeners: 0,
    emit(value) {
      listener?.(value);
    },
    backgroundTaskIdentifier: () => 'com.kvitto.app.ios.jobs.processing',
    drainPendingBackgroundLaunches: () => {
      const pending = native.buffered;
      native.buffered = [];
      return pending;
    },
    isBackgroundLaunchExpired: (handle) => native.expired.has(handle),
    finishBackgroundLaunch: (handle, success) => {
      native.finished.push({ handle, success });
      return true;
    },
    scheduleBackgroundProcessing:
      overrides.scheduleBackgroundProcessing ??
      (async () => {
        native.scheduleCalls += 1;
        return 'scheduled';
      }),
    onBackgroundLaunch: (next) => {
      listener = next;
      native.listeners += 1;
      return {
        remove: () => {
          listener = null;
          native.listeners -= 1;
        },
      };
    },
    logDiagnostic: (category, message) => {
      native.diagnostics.push({ category, message });
    },
  };

  return native;
}

function okOutcome(processed = 1): BackgroundSweepOutcome {
  return {
    outcome: 'processed',
    summary: { processed, lastResult: 'done', stopReason: 'idle', elapsedMs: 5 },
    pendingJobs: 0,
  };
}

describe('background task controller', () => {
  test('runs a window that was buffered before JavaScript existed', async () => {
    // The case the whole feature is for: iOS launches the app into the
    // background to run the task, so the window opens before there is a
    // runtime to deliver an event to. If this only listened for events, a cold
    // background launch would do nothing at all and still look healthy.
    const native = makeNative();
    native.buffered.push(launch('cold'));

    const seen: BackgroundSweepOptions[] = [];
    const controller = createBackgroundTaskController({
      native,
      sweep: async (options) => {
        seen.push(options);
        return okOutcome();
      },
    });

    await controller.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toHaveLength(1);
    expect(native.finished).toEqual([{ handle: 'cold', success: true }]);
    controller.stop();
  });

  test('completes the window even when the sweep throws', async () => {
    // iOS terminates an app that never completes a task it launched. A sweep
    // that throws must not take the completion with it.
    const native = makeNative();
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => {
        throw new Error('database is locked');
      },
    });

    await controller.start();
    const result = await controller.runLaunch(launch('boom'));

    expect(result).toBeNull();
    expect(native.finished).toEqual([{ handle: 'boom', success: false }]);
    expect(native.diagnostics.map((entry) => entry.category)).toContain(BACKGROUND_TASK_MARKERS.failed);
    controller.stop();
  });

  test('completes each window exactly once', async () => {
    // `setTaskCompleted` traps on a second call. One completion per window,
    // whatever else happens.
    const native = makeNative();
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => okOutcome(),
    });

    await controller.start();
    await controller.runLaunch(launch('one'));
    await controller.runLaunch(launch('two'));

    expect(native.finished).toEqual([
      { handle: 'one', success: true },
      { handle: 'two', success: true },
    ]);
    controller.stop();
  });

  test('refuses a second window while one is running, and finishes it anyway', async () => {
    const native = makeNative();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let sweeps = 0;
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => {
        sweeps += 1;
        await gate;
        return okOutcome();
      },
    });

    await controller.start();
    const first = controller.runLaunch(launch('first'));
    const second = await controller.runLaunch(launch('second'));

    expect(second).toBeNull();
    // Refused, but still completed - a window left open costs the app its life.
    expect(native.finished).toEqual([{ handle: 'second', success: false }]);

    release();
    await first;

    expect(sweeps).toBe(1);
    expect(native.finished).toContainEqual({ handle: 'first', success: true });
    controller.stop();
  });

  test('invents a deadline from the assumed budget, since iOS supplies none', async () => {
    const native = makeNative();
    let seen: BackgroundSweepOptions | null = null;

    const controller = createBackgroundTaskController({
      native,
      now: () => 50_000,
      assumedWindowMs: 9_000,
      maxJobsPerWindow: 4,
      sweep: async (options) => {
        seen = options;
        return okOutcome();
      },
    });

    await controller.start();
    await controller.runLaunch(launch('window', 49_000));

    const options = seen as BackgroundSweepOptions | null;
    expect(options).not.toBeNull();
    expect(options?.window.startedAt).toBe(49_000);
    expect(options?.window.deadlineAt).toBe(59_000);
    expect(options?.maxJobs).toBe(4);
    controller.stop();
  });

  test('reports expiration straight from the native handle', async () => {
    // The sweep polls rather than awaits, because iOS delivers expiration by
    // calling a handler on its own thread. A stale answer here is what gets a
    // job killed mid-run.
    const native = makeNative();
    let probe: (() => boolean) | null = null;

    const controller = createBackgroundTaskController({
      native,
      sweep: async (options) => {
        probe = () => options.expiration?.isExpired() ?? false;
        return okOutcome();
      },
    });

    await controller.start();
    await controller.runLaunch(launch('watched'));

    const isExpired = probe as (() => boolean) | null;
    expect(isExpired?.()).toBe(false);
    native.expired.add('watched');
    expect(isExpired?.()).toBe(true);
    controller.stop();
  });

  test('asks for another window after a failed sweep', async () => {
    // Otherwise one bad sweep ends background processing until someone opens
    // the app, which is exactly when background processing is not needed.
    const native = makeNative();
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => {
        throw new Error('nope');
      },
    });

    await controller.start();
    const after = native.scheduleCalls;
    await controller.runLaunch(launch('failed'));
    await Promise.resolve();
    await Promise.resolve();

    expect(native.scheduleCalls).toBeGreaterThan(after);
    controller.stop();
  });

  test('survives a scheduler that refuses', async () => {
    // `BGTaskScheduler.submit` throws when Background App Refresh is off. That
    // is a normal device state, not an error worth failing boot over.
    const native = makeNative({
      scheduleBackgroundProcessing: async () => {
        throw new Error('BGTaskSchedulerErrorDomain error 1');
      },
    });

    const controller = createBackgroundTaskController({
      native,
      sweep: async () => okOutcome(),
    });

    await expect(controller.start()).resolves.toBe('unavailable');
    controller.stop();
  });

  test('stop removes the listener so a disposed composition stops sweeping', async () => {
    const native = makeNative();
    let sweeps = 0;
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => {
        sweeps += 1;
        return okOutcome();
      },
    });

    await controller.start();
    expect(native.listeners).toBe(1);

    native.emit(launch('live'));
    await Promise.resolve();
    await Promise.resolve();
    expect(sweeps).toBe(1);

    controller.stop();
    expect(native.listeners).toBe(0);

    native.emit(launch('after-stop'));
    await Promise.resolve();
    await Promise.resolve();
    expect(sweeps).toBe(1);
  });
});

describe('background task controller: manual sweep', () => {
  test('sweeps without an OS window, and completes nothing', async () => {
    // A `BGProcessingTask` can sit queued for hours, so waiting for a real
    // window is no way to find out whether the drain works. This path exists
    // for the debug screen; it must not pretend to own an iOS task.
    const native = makeNative();
    let seen: BackgroundSweepOptions | null = null;

    const controller = createBackgroundTaskController({
      native,
      sweep: async (options) => {
        seen = options;
        return okOutcome(2);
      },
    });

    const outcome = await controller.sweepNow();

    expect(outcome?.summary?.processed).toBe(2);
    expect(native.finished).toEqual([]);
    // An unknown handle reads as expired on the native side, so asking would
    // stop the sweep before its first job. It must not ask.
    const options = seen as BackgroundSweepOptions | null;
    expect(options?.expiration).toBeUndefined();
    controller.stop();
  });

  test('does not ask iOS for a window just because someone pressed sweep', async () => {
    const native = makeNative();
    const controller = createBackgroundTaskController({
      native,
      sweep: async () => okOutcome(),
    });

    await controller.sweepNow();
    await Promise.resolve();

    expect(native.scheduleCalls).toBe(0);
    controller.stop();
  });
});
