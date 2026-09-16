import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  InMemoryJobStore,
  InMemoryCanonicalRepository,
  runOneDurableJobStrictDispatch,
  runOneDurableJobStrict,
  type Clock,
  type Logger,
  type SchedulerPort,
} from '../dist/index.js';
import { cloneReceipt } from '../dist/testing/builders.js';

class FakeClock implements Clock {
  private current: number;

  constructor(initial = 1_000) {
    this.current = initial;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const scheduler: SchedulerPort = {
  delayMs: (attempt: number) => Math.min(60_000, 500 * 2 ** Math.max(0, attempt - 1)),
};

test('prioritizes highest priority and earliest nextAttemptAt when claiming', async () => {
  const clock = new FakeClock(10_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r1', updatedAt: 100, dirty: 0, rev: 1 }));
  await repo.upsert('receipts', cloneReceipt({ id: 'r2', updatedAt: 200, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-low',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r1',
    sourceUpdatedAt: 100,
    priority: 1,
    nextAttemptAt: clock.now(),
    maxAttempts: 3,
  });

  await jobs.enqueue({
    id: 'j-high-later',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r2',
    sourceUpdatedAt: 200,
    priority: 5,
    nextAttemptAt: clock.now() + 1_000,
    maxAttempts: 3,
  });

  await jobs.enqueue({
    id: 'j-high-now',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r2',
    sourceUpdatedAt: 200,
    priority: 5,
    nextAttemptAt: clock.now(),
    maxAttempts: 3,
  });

  let claimedId = '';
  const result = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      kind: 'ocr',
      handle: async (ctx) => {
        claimedId = ctx.claim.id;
      },
    },
  );

  assert.equal(result, 'done');
  assert.equal(claimedId, 'j-high-now');
});

test('retries with backoff and cancels when max attempts are exhausted', async () => {
  const clock = new FakeClock(20_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-backoff', updatedAt: 1_000, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-max',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-backoff',
    sourceUpdatedAt: 1_000,
    priority: 10,
    nextAttemptAt: clock.now(),
    maxAttempts: 1,
  });

  const result = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 1_000,
      kind: 'ocr',
      handle: async () => {
        throw new Error('transient');
      },
    },
  );

  assert.equal(result, 'max_attempts');
  const row = await jobs.get('j-max');
  assert.equal(row?.state, 'cancelled');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, 'transient');
  assert.ok((row?.nextAttemptAt ?? 0) >= clock.now());
});

test('recovers after crash/lease expiration with fake clock by allowing reclaim', async () => {
  const clock = new FakeClock(30_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-recover', updatedAt: 9_000, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-recover',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-recover',
    sourceUpdatedAt: 9_000,
    priority: 1,
    nextAttemptAt: clock.now(),
    maxAttempts: 5,
  });

  const claimed = await jobs.claimNext(clock.now(), 2_000);
  assert.ok(claimed);

  const beforeLeaseEnd = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      kind: 'ocr',
      handle: async () => {},
    },
  );

  assert.equal(beforeLeaseEnd, 'none');

  clock.advance(2_100);

  const afterLeaseEnd = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      kind: 'ocr',
      handle: async () => {},
    },
  );

  assert.equal(afterLeaseEnd, 'done');
  const row = await jobs.get('j-recover');
  assert.equal(row?.state, 'done');
  assert.equal(row?.attempts, 2);
});

test('supports cancellation and stale source/result suppression', async () => {
  const clock = new FakeClock(40_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-cancel', updatedAt: 4_000, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-cancel',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-cancel',
    sourceUpdatedAt: 4_000,
    priority: 10,
    nextAttemptAt: clock.now(),
    maxAttempts: 4,
  });

  const cancelled = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 3_000,
      kind: 'ocr',
      handle: async (ctx) => {
        await jobs.requestCancel(ctx.claim.id, clock.now());
        await ctx.reportProgress(0.5);
      },
    },
  );

  assert.equal(cancelled, 'cancelled');
  const cancelledRow = await jobs.get('j-cancel');
  assert.equal(cancelledRow?.state, 'cancelled');

  await repo.upsert('receipts', cloneReceipt({ id: 'r-stale-source', updatedAt: 4_001, dirty: 0, rev: 1 }));
  await jobs.enqueue({
    id: 'j-stale-source',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-stale-source',
    sourceUpdatedAt: 4_001,
    priority: 8,
    nextAttemptAt: clock.now(),
    maxAttempts: 4,
  });

  await repo.upsert('receipts', cloneReceipt({ id: 'r-stale-source', updatedAt: 9_999, dirty: 0, rev: 2 }));

  const staleSource = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 3_000,
      kind: 'ocr',
      handle: async () => {
        throw new Error('must not run for stale source');
      },
    },
  );

  assert.equal(staleSource, 'stale_source');

  await repo.upsert('receipts', cloneReceipt({ id: 'r-stale-result', updatedAt: 5_000, dirty: 0, rev: 1 }));
  await jobs.enqueue({
    id: 'j-stale-result',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-stale-result',
    sourceUpdatedAt: 5_000,
    priority: 7,
    nextAttemptAt: clock.now(),
    maxAttempts: 4,
  });

  const staleResult = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 3_000,
      kind: 'ocr',
      handle: async () => {
        await repo.upsert('receipts', cloneReceipt({ id: 'r-stale-result', updatedAt: 5_100, dirty: 0, rev: 2 }));
      },
    },
  );

  assert.equal(staleResult, 'stale_result');
});

test('suppresses stale completion when claim ownership is lost', async () => {
  const clock = new FakeClock(50_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-loss', updatedAt: 7_000, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-loss',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'r-loss',
    sourceUpdatedAt: 7_000,
    priority: 10,
    nextAttemptAt: clock.now(),
    maxAttempts: 5,
  });

  const result = await runOneDurableJobStrict(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 500,
      kind: 'ocr',
      handle: async () => {
        clock.advance(700);
        await jobs.claimNext(clock.now(), 500);
      },
    },
  );

  assert.equal(result, 'stale_result');
  const row = await jobs.get('j-loss');
  assert.equal(row?.state, 'running');
  assert.equal(row?.attempts, 2);
});

test('dispatches claimed durable jobs by kind without cross-kind retries', async () => {
  const clock = new FakeClock(60_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-dispatch-a', updatedAt: 1_000, dirty: 0, rev: 1 }));
  await repo.upsert('receipts', cloneReceipt({ id: 'r-dispatch-b', updatedAt: 2_000, dirty: 0, rev: 1 }));

  await jobs.enqueue({
    id: 'j-dispatch-image',
    kind: 'scan:image-processing',
    sourceKind: 'receipt',
    sourceId: 'r-dispatch-a',
    sourceUpdatedAt: 1_000,
    priority: 20,
    nextAttemptAt: clock.now(),
    maxAttempts: 3,
  });

  await jobs.enqueue({
    id: 'j-dispatch-ocr',
    kind: 'scan:ocr',
    sourceKind: 'receipt',
    sourceId: 'r-dispatch-b',
    sourceUpdatedAt: 2_000,
    priority: 10,
    nextAttemptAt: clock.now(),
    maxAttempts: 3,
  });

  const called: string[] = [];

  const first = await runOneDurableJobStrictDispatch(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      handlers: {
        'scan:image-processing': async () => {
          called.push('scan:image-processing');
        },
        'scan:ocr': async () => {
          called.push('scan:ocr');
        },
      },
    },
  );

  const second = await runOneDurableJobStrictDispatch(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      handlers: {
        'scan:image-processing': async () => {
          called.push('scan:image-processing');
        },
        'scan:ocr': async () => {
          called.push('scan:ocr');
        },
      },
    },
  );

  assert.equal(first, 'done');
  assert.equal(second, 'done');
  assert.deepEqual(called, ['scan:image-processing', 'scan:ocr']);
  assert.equal((await jobs.get('j-dispatch-image'))?.attempts, 1);
  assert.equal((await jobs.get('j-dispatch-ocr'))?.attempts, 1);
});

test('dispatcher cancels unsupported kinds without retry inflation', async () => {
  const clock = new FakeClock(70_000);
  const repo = new InMemoryCanonicalRepository();
  const jobs = new InMemoryJobStore();

  await repo.upsert('receipts', cloneReceipt({ id: 'r-unsupported', updatedAt: 3_000, dirty: 0, rev: 1 }));
  await jobs.enqueue({
    id: 'j-unsupported',
    kind: 'scan:unknown',
    sourceKind: 'receipt',
    sourceId: 'r-unsupported',
    sourceUpdatedAt: 3_000,
    priority: 5,
    nextAttemptAt: clock.now(),
    maxAttempts: 3,
  });

  const result = await runOneDurableJobStrictDispatch(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 2_000,
      handlers: {
        'scan:ocr': async () => {},
      },
    },
  );

  assert.equal(result, 'cancelled');
  const row = await jobs.get('j-unsupported');
  assert.equal(row?.state, 'cancelled');
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, null);
});
