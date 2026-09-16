import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENTITY_KINDS } from '@kvitto/shared/domain';

import {
  InMemoryBlobStore,
  InMemoryCanonicalRepository,
  InMemoryJobStore,
  InMemorySyncTransport,
  runOneDurableJob,
  runSyncPass,
  type Clock,
  type Logger,
  type NetworkPort,
  type SchedulerPort,
} from '../dist/index.js';
import { buildEntity, cloneReceipt } from '../dist/testing/builders.js';

class FakeClock implements Clock {
  private current: number;

  constructor(current = 10_000) {
    this.current = current;
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

const network: NetworkPort = { isOnline: () => true };

const scheduler: SchedulerPort = {
  delayMs: (attempt) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1)),
};

test('in-memory repository supports CRUD and dirty semantics for all entity kinds', async () => {
  const repo = new InMemoryCanonicalRepository();

  for (const kind of ENTITY_KINDS) {
    const row = buildEntity(kind);
    await repo.upsert(kind, row);
    const got = await repo.get(kind, row.id);
    assert.ok(got);
    assert.equal(got?.id, row.id);

    const deleted = await repo.tombstone(kind, row.id, 20_000);
    assert.ok(deleted);
    assert.equal(deleted?.dirty, 1);
    assert.equal(deleted?.deletedAt, 20_000);
  }

  const counts = await repo.countByKind();
  for (const kind of ENTITY_KINDS) {
    assert.equal(counts[kind], 1);
  }

  assert.equal(await repo.countDirty(), ENTITY_KINDS.length);
});

test('sync pass pushes before pulls and handles global paging order', async () => {
  const repo = new InMemoryCanonicalRepository();
  const localReceipt = cloneReceipt({ id: 'r-local', total: 100, dirty: 1, updatedAt: 2000, rev: 0 });
  await repo.upsert('receipts', localReceipt);

  const page1Receipt = cloneReceipt({ id: 'r-remote-1', total: 10, dirty: 0, rev: 5, updatedAt: 3000 });
  const page1Secret = buildEntity('secrets', { id: 'companyApiKey', value: 'sekret', dirty: 0, rev: 6, updatedAt: 3001 });
  const page2Tag = buildEntity('tags', { id: 't-remote', dirty: 0, rev: 7, updatedAt: 3002 });

  const transport = new InMemorySyncTransport({
    pullPages: [
      {
        changes: {
          receipts: [page1Receipt],
          secrets: [page1Secret],
        },
        cursor: 6,
        hasMore: true,
        serverTime: Date.now(),
        epoch: 'epoch-1',
      },
      {
        changes: {
          tags: [page2Tag],
        },
        cursor: 7,
        hasMore: false,
        serverTime: Date.now(),
        epoch: 'epoch-1',
      },
    ],
  });

  const blobStore = new InMemoryBlobStore(() => 11_000);
  await blobStore.put({ id: 'blob-a', mimeType: 'image/jpeg', width: 100, height: 200, size: 3000, role: 'processed' });

  const result = await runSyncPass({
    repo,
    transport,
    blobs: blobStore,
    clock: new FakeClock(),
    logger,
    network,
  });

  const pushes = transport.getPushes();
  assert.equal(pushes.length, 1);
  assert.ok((pushes[0].changes.receipts ?? []).some((row) => row.id === 'r-local'));

  assert.equal(result.pullProgress.pages, 2);
  assert.equal(result.uploadedBlobs, 1);

  const syncedState = await repo.getSyncState();
  assert.equal(syncedState.cursor, 7);

  const remoteSecret = await repo.get('secrets', 'companyApiKey');
  assert.ok(remoteSecret);
  const remoteTag = await repo.get('tags', 't-remote');
  assert.ok(remoteTag);
});

test('record is marked clean only when updatedAt still matches push snapshot', async () => {
  const repo = new InMemoryCanonicalRepository();
  const row = cloneReceipt({ id: 'r1', total: 50, dirty: 1, updatedAt: 1000, rev: 0 });
  await repo.upsert('receipts', row);

  const snapshots = await repo.listDirty(10);
  assert.equal(snapshots.length, 1);

  await repo.upsert('receipts', { ...row, total: 55, updatedAt: 1200, dirty: 1, rev: 0 });

  const cleaned = await repo.markCleanIfUpdatedAtMatches(snapshots[0], 42);
  assert.equal(cleaned, false);

  const current = await repo.get('receipts', 'r1');
  assert.equal(current?.dirty, 1);
  assert.equal(current?.rev, 0);
});

test('epoch change resets cursor without erasing local rows', async () => {
  const repo = new InMemoryCanonicalRepository();
  await repo.upsert('receipts', cloneReceipt({ id: 'keep-me', dirty: 0, rev: 2, updatedAt: 2000 }));
  await repo.setSyncState({ cursor: 99, epoch: 'epoch-old' });

  const transport = new InMemorySyncTransport({
    pullPages: [
      {
        changes: {},
        cursor: 0,
        hasMore: false,
        serverTime: Date.now(),
        epoch: 'epoch-new',
      },
      {
        changes: {},
        cursor: 1,
        hasMore: false,
        serverTime: Date.now(),
        epoch: 'epoch-new',
      },
    ],
  });

  const result = await runSyncPass({
    repo,
    transport,
    blobs: new InMemoryBlobStore(),
    clock: new FakeClock(),
    logger,
    network,
  });

  assert.equal(result.resetCursor, true);
  const state = await repo.getSyncState();
  assert.equal(state.epoch, 'epoch-new');
  assert.equal(state.cursor, 1);

  const preserved = await repo.get('receipts', 'keep-me');
  assert.ok(preserved);
});

test('dirty local receipt merges conservatively against machine-written remote extraction', async () => {
  const repo = new InMemoryCanonicalRepository();
  const local = cloneReceipt({
    id: 'r-merge',
    total: 999,
    notes: 'manual fix',
    dirty: 1,
    updatedAt: 2000,
    rev: 1,
    status: 'draft',
  });
  await repo.upsert('receipts', local);

  const remote = cloneReceipt({
    id: 'r-merge',
    total: 431.5,
    purchasedAt: '2026-03-15T14:22:00',
    dirty: 0,
    rev: 7,
    updatedAt: 5000,
    status: 'parsed',
    extraction: {
      provider: 'local-llm',
      model: 'qwen3-vl:4b',
      at: 6000,
      durationMs: 1200,
      inputTokens: null,
      outputTokens: null,
      warnings: [],
      error: null,
    },
  });

  const applyResult = await repo.applyIncoming({ receipts: [remote] });
  assert.equal(applyResult.merged, 1);

  const merged = await repo.get('receipts', 'r-merge');
  assert.equal(merged?.total, 999);
  assert.equal(merged?.purchasedAt, '2026-03-15T14:22:00');
  assert.equal(merged?.dirty, 1);
  assert.equal(merged?.rev, 7);
  assert.ok((merged?.updatedAt ?? 0) > 5000);
});

test('durable job retries on failure then succeeds while preserving stale safety', async () => {
  const clock = new FakeClock(20_000);
  const repo = new InMemoryCanonicalRepository();
  await repo.upsert('receipts', cloneReceipt({ id: 'receipt-job', dirty: 0, updatedAt: 2000, rev: 3 }));

  const jobs = new InMemoryJobStore();
  await jobs.enqueue({
    id: 'job-1',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'receipt-job',
    sourceUpdatedAt: 2000,
    priority: 10,
    nextAttemptAt: clock.now(),
    maxAttempts: 4,
  });

  let calls = 0;
  const first = await runOneDurableJob(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 5000,
      kind: 'ocr',
      handle: async () => {
        calls += 1;
        throw new Error('temporary');
      },
    },
  );

  assert.equal(first, 'retry');
  const afterRetry = await jobs.get('job-1');
  assert.equal(afterRetry?.state, 'failed');
  assert.equal(afterRetry?.attempts, 1);
  assert.ok((afterRetry?.nextAttemptAt ?? 0) > clock.now());

  clock.advance((afterRetry?.nextAttemptAt ?? clock.now()) - clock.now());

  const second = await runOneDurableJob(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 5000,
      kind: 'ocr',
      handle: async () => {
        calls += 1;
      },
    },
  );

  assert.equal(second, 'done');
  assert.equal(calls, 2);
  const final = await jobs.get('job-1');
  assert.equal(final?.state, 'done');

  await jobs.enqueue({
    id: 'job-stale',
    kind: 'ocr',
    sourceKind: 'receipt',
    sourceId: 'receipt-job',
    sourceUpdatedAt: 2000,
    priority: 5,
    nextAttemptAt: clock.now(),
    maxAttempts: 2,
  });
  await repo.upsert('receipts', cloneReceipt({ id: 'receipt-job', dirty: 1, updatedAt: 9999, rev: 3 }));

  const stale = await runOneDurableJob(
    { jobs, repo, clock, scheduler, logger },
    {
      leaseMs: 5000,
      kind: 'ocr',
      handle: async () => {
        throw new Error('must not execute stale job');
      },
    },
  );

  assert.equal(stale, 'stale');
  const staleJob = await jobs.get('job-stale');
  assert.equal(staleJob?.state, 'done');
});
