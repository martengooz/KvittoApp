/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';

import {
  createBackgroundJobRunner,
  type BackgroundSweepOptions,
} from '../src/jobs/background-runner';
import type { ForegroundRunResult, ForegroundRunnerLogger } from '../src/jobs/foreground-runner';
import type { JobBackgroundWindow, PersistentJobStoreDependency } from '../src/jobs/contracts';

const STORE: PersistentJobStoreDependency = {
  durable: true,
  persistence: 'sqlcipher',
};

function silentLogger(): ForegroundRunnerLogger {
  return { info: () => undefined, warn: () => undefined };
}

/** A clock the test advances itself, so budgets are exact and nothing sleeps. */
function fakeClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

function window(overrides: Partial<JobBackgroundWindow> = {}): JobBackgroundWindow {
  return { startedAt: 1_000, deadlineAt: 1_000 + 30_000, opportunistic: true, ...overrides };
}

/**
 * Builds a runner whose jobs each consume `costMs` of the fake clock, so the
 * budget arithmetic is driven by the same clock the runner reads.
 */
function makeRunner(options: {
  clock: ReturnType<typeof fakeClock>;
  results: ForegroundRunResult[];
  costMs?: number;
  onRun?: (index: number) => void;
}) {
  let index = 0;
  const runner = createBackgroundJobRunner({
    store: STORE,
    logger: silentLogger(),
    now: options.clock.now,
    runOne: async () => {
      const result = options.results[index] ?? 'none';
      options.onRun?.(index);
      index += 1;
      options.clock.advance(options.costMs ?? 1_000);
      return result;
    },
  });
  return { runner, runCount: () => index };
}

function sweepOptions(overrides: Partial<BackgroundSweepOptions> = {}): BackgroundSweepOptions {
  return { window: window(), maxJobs: 10, ...overrides };
}

describe('background sweep budget', () => {
  test('runs jobs until the queue is empty', async () => {
    const clock = fakeClock();
    const { runner } = makeRunner({ clock, results: ['done', 'done', 'none'] });

    const summary = await runner.sweep(sweepOptions());

    expect(summary.processed).toBe(2);
    expect(summary.stopReason).toBe('idle');
    expect(summary.lastResult).toBe('none');
  });

  test('stops before the deadline rather than at it', async () => {
    const clock = fakeClock();
    // Ten seconds of window, jobs costing four seconds each.
    const { runner } = makeRunner({
      clock,
      results: ['done', 'done', 'done', 'done'],
      costMs: 4_000,
    });

    const summary = await runner.sweep(
      sweepOptions({ window: window({ deadlineAt: 1_000 + 10_000 }), reserveMs: 1_000 }),
    );

    expect(summary.stopReason).toBe('budget');
    // Never overruns: the sweep must end before the window closes.
    expect(summary.elapsedMs).toBeLessThan(10_000);
  });

  test('a window too small for any job runs nothing at all', async () => {
    const clock = fakeClock();
    const { runner, runCount } = makeRunner({ clock, results: ['done'], costMs: 5_000 });

    const summary = await runner.sweep(
      sweepOptions({ window: window({ deadlineAt: 1_000 + 1_500 }), reserveMs: 1_000 }),
    );

    // Starting a job it cannot finish is the one outcome that costs something:
    // the claim outlives the process and blocks a retry.
    expect(runCount()).toBe(0);
    expect(summary.processed).toBe(0);
    expect(summary.stopReason).toBe('budget');
  });

  test('a window with no deadline still gets a budget', async () => {
    const clock = fakeClock();
    const { runner } = makeRunner({
      clock,
      // More work than the fallback budget can cover.
      results: new Array(100).fill('done') as ForegroundRunResult[],
      costMs: 1_000,
    });

    const summary = await runner.sweep(
      sweepOptions({ window: window({ deadlineAt: null }), maxJobs: 100, fallbackBudgetMs: 6_000 }),
    );

    expect(summary.stopReason).toBe('budget');
    expect(summary.processed).toBeGreaterThan(0);
    expect(summary.elapsedMs).toBeLessThanOrEqual(6_000);
  });

  test('a slow job shrinks what the sweep will attempt next', async () => {
    const clock = fakeClock();
    let index = 0;
    const runner = createBackgroundJobRunner({
      store: STORE,
      logger: silentLogger(),
      now: clock.now,
      runOne: async () => {
        // First job is cheap, second is very slow.
        clock.advance(index === 0 ? 500 : 6_000);
        index += 1;
        return 'done';
      },
    });

    const summary = await runner.sweep(
      sweepOptions({ window: window({ deadlineAt: 1_000 + 12_000 }), reserveMs: 1_000 }),
    );

    // Two jobs fit; a third is refused because jobs have proven to cost 6s.
    expect(summary.processed).toBe(2);
    expect(summary.stopReason).toBe('budget');
  });
});

describe('background sweep expiration', () => {
  test('stops as soon as iOS revokes the window', async () => {
    const clock = fakeClock();
    let expired = false;
    const { runner, runCount } = makeRunner({
      clock,
      results: ['done', 'done', 'done', 'done'],
      onRun: (index) => {
        if (index === 1) expired = true;
      },
    });

    const summary = await runner.sweep(
      sweepOptions({ expiration: { isExpired: () => expired } }),
    );

    // The job already in flight finishes; no further job is started.
    expect(runCount()).toBe(2);
    expect(summary.processed).toBe(2);
    expect(summary.stopReason).toBe('expired');
  });

  test('an already expired window starts nothing', async () => {
    const clock = fakeClock();
    const { runner, runCount } = makeRunner({ clock, results: ['done'] });

    const summary = await runner.sweep(sweepOptions({ expiration: { isExpired: () => true } }));

    expect(runCount()).toBe(0);
    expect(summary.stopReason).toBe('expired');
  });
});

describe('background sweep limits and lifecycle', () => {
  test('honours the per-window job cap', async () => {
    const clock = fakeClock();
    const { runner } = makeRunner({ clock, results: new Array(10).fill('done') as ForegroundRunResult[] });

    const summary = await runner.sweep(sweepOptions({ maxJobs: 3 }));

    expect(summary.processed).toBe(3);
    expect(summary.stopReason).toBe('max-jobs');
  });

  test('a stopped runner does nothing', async () => {
    const clock = fakeClock();
    const { runner, runCount } = makeRunner({ clock, results: ['done'] });

    runner.stop();
    const summary = await runner.sweep(sweepOptions());

    expect(runCount()).toBe(0);
    expect(summary.stopReason).toBe('stopped');
    expect(runner.isActive()).toBe(false);

    runner.start();
    expect(runner.isActive()).toBe(true);
  });

  test('deferred jobs are counted, not treated as an empty queue', async () => {
    const clock = fakeClock();
    const { runner } = makeRunner({ clock, results: ['retry', 'max_attempts', 'none'] });

    const summary = await runner.sweep(sweepOptions());

    // A job that asked to retry still consumed the window.
    expect(summary.processed).toBe(2);
    expect(summary.stopReason).toBe('idle');
  });

  test('a non-durable store is refused, because background work outlives memory', () => {
    expect(() =>
      createBackgroundJobRunner({
        store: { durable: false } as unknown as PersistentJobStoreDependency,
        logger: silentLogger(),
        runOne: async () => 'none',
      }),
    ).toThrow('persistent durable store');
  });

  test('maxJobs must be positive', async () => {
    const clock = fakeClock();
    const { runner } = makeRunner({ clock, results: [] });
    await expect(runner.sweep(sweepOptions({ maxJobs: 0 }))).rejects.toThrow('maxJobs must be > 0');
  });
});
