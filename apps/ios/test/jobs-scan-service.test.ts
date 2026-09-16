import { describe, expect, test } from '@jest/globals';

import { InMemoryJobStore } from '@kvitto/client-core/fakes';

import { createScanDurableJobService } from '../src/jobs/service';

describe('scan durable job service', () => {
  test('maps scan queue jobs into durable job records with stable source fields', async () => {
    const store = new InMemoryJobStore();
    const service = createScanDurableJobService({
      store,
      clock: { now: () => 10_000 },
      idFactory: (job) => `det-${job.kind}-${job.receiptId}`,
    });

    await service.queue.enqueue({
      kind: 'image-processing',
      receiptId: 'receipt-1',
      sourceVersion: 123,
      sourceImageId: 'sha-1',
    });
    await service.queue.enqueue({
      kind: 'ocr',
      receiptId: 'receipt-1',
      sourceVersion: 123,
      sourceImageId: 'sha-1',
    });

    const rows = (await service.list()).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(rows).toHaveLength(2);

    const image = rows[0]!;
    const ocr = rows[1]!;

    expect(image.kind).toBe('scan:image-processing');
    expect(image.sourceKind).toBe('receipt');
    expect(image.sourceId).toBe('receipt-1');
    expect(image.sourceUpdatedAt).toBe(123);
    expect(image.priority).toBe(220);
    expect(image.maxAttempts).toBe(4);

    expect(ocr.kind).toBe('scan:ocr');
    expect(ocr.sourceKind).toBe('receipt');
    expect(ocr.sourceId).toBe('receipt-1');
    expect(ocr.sourceUpdatedAt).toBe(123);
    expect(ocr.priority).toBe(140);
    expect(ocr.maxAttempts).toBe(3);
  });

  test('avoids duplicate durable ids from deterministic idFactory', async () => {
    const store = new InMemoryJobStore();
    const service = createScanDurableJobService({
      store,
      clock: { now: () => 20_000 },
      idFactory: () => 'stable-id',
    });

    await service.enqueue({
      kind: 'ocr',
      receiptId: 'receipt-2',
      sourceVersion: 1,
      sourceImageId: null,
    });
    await service.enqueue({
      kind: 'ocr',
      receiptId: 'receipt-2',
      sourceVersion: 2,
      sourceImageId: null,
    });

    const rows = await service.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('stable-id');
  });

  test('returns unsupported foreground drain when no production handlers exist', async () => {
    const store = new InMemoryJobStore();
    const service = createScanDurableJobService({
      store,
      clock: { now: () => 30_000 },
      idFactory: () => 'pending-id',
    });

    await service.enqueue({
      kind: 'ocr',
      receiptId: 'receipt-3',
      sourceVersion: 1,
      sourceImageId: null,
    });

    const outcome = await service.drainForeground(2);
    expect(outcome.outcome).toBe('unsupported');
    expect(outcome.pendingJobs).toBe(1);
    expect(outcome.summary).toBeNull();
  });

  test('runner lifecycle stop defers foreground work when runner is wired', async () => {
    const store = new InMemoryJobStore();
    const service = createScanDurableJobService({
      store,
      runOne: async () => 'done',
      idFactory: () => 'id',
    });

    service.stop();
    const deferred = await service.drainForeground(3);
    expect(deferred.outcome).toBe('deferred');

    service.start();
    const processed = await service.drainForeground(1);
    expect(processed.outcome).toBe('processed');
    expect(service.isActive()).toBe(true);
  });

  test('cancel marks pending jobs as cancelled', async () => {
    let now = 40_000;
    const store = new InMemoryJobStore();
    const service = createScanDurableJobService({
      store,
      clock: { now: () => now },
      idFactory: () => 'cancel-id',
    });

    await service.enqueue({
      kind: 'image-processing',
      receiptId: 'receipt-4',
      sourceVersion: 1,
      sourceImageId: 'sha',
    });

    now = 40_100;
    await service.cancel('cancel-id');

    const row = await store.get('cancel-id');
    expect(row?.state).toBe('cancelled');
    expect(row?.cancelRequested).toBe(true);
  });
});