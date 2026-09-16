import { describe, expect, test } from '@jest/globals';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { createRepositoryBackedJobStore } from '../src/jobs/store';

describe('repository-backed durable job store', () => {
  test('persists jobs across repository recreation via kv snapshot', async () => {
    const adapter = new SqliteTestAdapter();
    let now = 1_000;

    const repositoryA = new IosDataRepository(adapter, () => now);
    const storeA = createRepositoryBackedJobStore({
      repository: repositoryA,
      clock: { now: () => now },
    });

    await storeA.enqueue({
      id: 'job-1',
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: 'r-1',
      sourceUpdatedAt: 100,
      priority: 10,
      nextAttemptAt: now,
      maxAttempts: 3,
    });

    now = 1_100;
    await storeA.claimNext(now, 500);

    const repositoryB = new IosDataRepository(adapter, () => now);
    const storeB = createRepositoryBackedJobStore({
      repository: repositoryB,
      clock: { now: () => now },
    });

    const restored = await storeB.get('job-1');
    expect(restored).not.toBeNull();
    expect(restored?.state).toBe('running');
    expect(restored?.attempts).toBe(1);
  });

  test('claimNext honors readiness, priority order, and lease recovery', async () => {
    const adapter = new SqliteTestAdapter();
    const repository = new IosDataRepository(adapter, () => 0);
    const store = createRepositoryBackedJobStore({ repository });

    await store.enqueue({
      id: 'a-low',
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: 'r-a',
      sourceUpdatedAt: 10,
      priority: 1,
      nextAttemptAt: 1_000,
      maxAttempts: 3,
    });
    await store.enqueue({
      id: 'b-not-ready',
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: 'r-b',
      sourceUpdatedAt: 10,
      priority: 99,
      nextAttemptAt: 2_000,
      maxAttempts: 3,
    });
    await store.enqueue({
      id: 'c-high',
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: 'r-c',
      sourceUpdatedAt: 10,
      priority: 10,
      nextAttemptAt: 1_000,
      maxAttempts: 3,
    });

    const first = await store.claimNext(1_000, 50);
    expect(first?.id).toBe('c-high');

    const second = await store.claimNext(1_010, 50);
    expect(second?.id).toBe('a-low');

    const third = await store.claimNext(1_020, 50);
    expect(third).toBeNull();

    const recovered = await store.claimNext(1_060, 50);
    expect(recovered?.id).toBe('c-high');

    const row = await store.get('c-high');
    expect(row?.state).toBe('running');
    expect(row?.attempts).toBe(2);
  });

  test('supports retry, cancel request, and cancellation transitions', async () => {
    const adapter = new SqliteTestAdapter();
    let now = 2_000;
    const repository = new IosDataRepository(adapter, () => now);
    const store = createRepositoryBackedJobStore({
      repository,
      clock: { now: () => now },
    });

    await store.enqueue({
      id: 'job-retry',
      kind: 'scan:image-processing',
      sourceKind: 'receipt',
      sourceId: 'r-2',
      sourceUpdatedAt: 11,
      priority: 30,
      nextAttemptAt: now,
      maxAttempts: 4,
    });

    await store.claimNext(now, 100);
    now = 2_010;
    await store.markProgress('job-retry', 0.6, now);
    now = 2_100;
    await store.markRetry('job-retry', now, 200, 'transient-failure');

    const failed = await store.get('job-retry');
    expect(failed?.state).toBe('failed');
    expect(failed?.nextAttemptAt).toBe(2_300);
    expect(failed?.lastError).toBe('transient-failure');

    now = 2_120;
    await store.requestCancel('job-retry', now);
    now = 2_121;
    await store.markCancelled('job-retry', now);

    const cancelled = await store.get('job-retry');
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.cancelRequested).toBe(true);
  });

  test('deduplicates duplicate enqueue ids and preserves first record', async () => {
    const adapter = new SqliteTestAdapter();
    let now = 3_000;
    const repository = new IosDataRepository(adapter, () => now);
    const store = createRepositoryBackedJobStore({
      repository,
      clock: { now: () => now },
    });

    const first = await store.enqueue({
      id: 'dup-1',
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: 'r-dup',
      sourceUpdatedAt: 1,
      priority: 1,
      nextAttemptAt: now,
      maxAttempts: 3,
    });

    now = 3_500;
    const second = await store.enqueue({
      id: 'dup-1',
      kind: 'scan:image-processing',
      sourceKind: 'receipt',
      sourceId: 'r-dup-changed',
      sourceUpdatedAt: 999,
      priority: 500,
      nextAttemptAt: now,
      maxAttempts: 9,
    });

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(second).toEqual(first);
    expect(rows[0]?.kind).toBe('scan:ocr');
  });

  test('serializes concurrent mutations without losing queued jobs', async () => {
    const repository = new IosDataRepository(new SqliteTestAdapter(), () => 4_000);
    const store = createRepositoryBackedJobStore({ repository });

    await Promise.all(['one', 'two', 'three'].map((id) => store.enqueue({
      id,
      kind: 'scan:ocr',
      sourceKind: 'receipt',
      sourceId: `receipt-${id}`,
      sourceUpdatedAt: 1,
      priority: 1,
      nextAttemptAt: 4_000,
      maxAttempts: 3,
    })));

    await expect(store.list()).resolves.toHaveLength(3);
  });
});