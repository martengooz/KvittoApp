import { describe, expect, test } from '@jest/globals';

import { createForegroundJobRunner } from '../src/jobs/foreground-runner';

describe('Packet 10 foreground runner', () => {
  test('drains until idle and reports processed count deterministically', async () => {
    const sequence = ['done', 'retry', 'stale_result', 'none'] as const;
    let index = 0;

    const runner = createForegroundJobRunner({
      store: { durable: true, persistence: 'sqlite' },
      runOne: async () => {
        const next = sequence[index] ?? 'none';
        index += 1;
        return next;
      },
      logger: {
        info: () => {},
        warn: () => {},
      },
    });

    const summary = await runner.drain({ maxJobsPerForegroundWindow: 10 });

    expect(summary.processed).toBe(3);
    expect(summary.lastResult).toBe('none');
    expect(summary.stoppedEarly).toBe(false);
  });

  test('stops early when max jobs budget is reached', async () => {
    const runner = createForegroundJobRunner({
      store: { durable: true, persistence: 'sqlcipher' },
      runOne: async () => 'done',
      logger: {
        info: () => {},
        warn: () => {},
      },
    });

    const summary = await runner.drain({ maxJobsPerForegroundWindow: 2 });

    expect(summary.processed).toBe(2);
    expect(summary.stoppedEarly).toBe(true);
  });

  test('honors explicit stop for opportunistic foreground execution', async () => {
    const runner = createForegroundJobRunner({
      store: { durable: true, persistence: 'custom' },
      runOne: async () => 'done',
      logger: {
        info: () => {},
        warn: () => {},
      },
    });

    runner.stop();
    const summary = await runner.drain({ maxJobsPerForegroundWindow: 4 });

    expect(summary.processed).toBe(0);
    expect(summary.stoppedEarly).toBe(true);
    expect(runner.isActive()).toBe(false);
  });

  test('requires durable persistent store dependency', () => {
    expect(() => {
      createForegroundJobRunner({
        store: { durable: false as true, persistence: 'sqlite' },
        runOne: async () => 'none',
        logger: {
          info: () => {},
          warn: () => {},
        },
      });
    }).toThrow('persistent durable store');
  });
});
