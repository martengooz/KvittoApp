import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENTITY_KINDS, type AnyEntity, type ChangeSet, type PairRequest, type PairResponse, type PullQuery, type PullResponse, type PushRequest, type PushResponse, type SyncStatusResponse, type WhoAmIResponse } from '@kvitto/shared/domain';

import {
  InMemoryBlobStore,
  InMemoryCanonicalRepository,
  createSharedInFlight,
  runSyncPass,
  type Clock,
  type Logger,
  type NetworkPort,
  type SyncTransportPort,
} from '../dist/index.js';
import { buildEntity } from '../dist/testing/builders.js';

const clock: Clock = { now: () => Date.now() };
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
const network: NetworkPort = { isOnline: () => true };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class RecordingTransport implements SyncTransportPort {
  public statusCalls = 0;
  public pullQueries: PullQuery[] = [];
  public pushes: PushRequest[] = [];
  public uploaded: string[] = [];
  public downloaded: string[] = [];

  private cursor = 0;
  private readonly pullPages: PullResponse[];
  private readonly statusReply: SyncStatusResponse;
  private readonly onPush?: (request: PushRequest, pushIndex: number) => Promise<void> | void;

  constructor(options: {
    statusReply?: Partial<SyncStatusResponse>;
    pullPages?: PullResponse[];
    onPush?: (request: PushRequest, pushIndex: number) => Promise<void> | void;
  } = {}) {
    this.statusReply = {
      cursor: 0,
      epoch: 'epoch-1',
      hasChanges: false,
      diverged: false,
      serverTime: Date.now(),
      ...options.statusReply,
    };
    this.pullPages = (options.pullPages ?? []).map((page) => clone(page));
    this.onPush = options.onPush;
  }

  async pair(request: PairRequest): Promise<PairResponse> {
    return {
      token: 'token',
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      accountId: 'acc-1',
      protocolVersion: 2,
      serverTime: Date.now(),
    };
  }

  async whoAmI(): Promise<WhoAmIResponse> {
    return {
      deviceId: 'dev-1',
      deviceName: 'Test',
      accountId: 'acc-1',
      protocolVersion: 2,
      serverTime: Date.now(),
      aiProxyEnabled: false,
      aiProxyModels: [],
    };
  }

  async status(_since: number): Promise<SyncStatusResponse> {
    this.statusCalls += 1;
    return clone(this.statusReply);
  }

  async push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(clone(request));
    await this.onPush?.(request, this.pushes.length - 1);

    const results: PushResponse['results'] = [];
    for (const kind of ENTITY_KINDS) {
      for (const row of request.changes[kind] ?? []) {
        this.cursor += 1;
        results.push({
          kind,
          id: row.id,
          rev: this.cursor,
          outcome: 'applied',
        });
      }
    }

    return {
      results,
      cursor: this.cursor,
      serverTime: Date.now(),
    };
  }

  async pull(query: PullQuery): Promise<PullResponse> {
    this.pullQueries.push({ ...query });
    const page = this.pullPages.shift();
    if (!page) {
      return {
        changes: {},
        cursor: this.cursor,
        hasMore: false,
        epoch: 'epoch-1',
        serverTime: Date.now(),
      };
    }
    this.cursor = Math.max(this.cursor, page.cursor);
    return clone(page);
  }

  async uploadBlobs(ids: string[]): Promise<void> {
    this.uploaded.push(...ids);
  }

  async downloadBlobs(ids: string[]): Promise<void> {
    this.downloaded.push(...ids);
  }
}

function countChanges(changes: ChangeSet): number {
  let total = 0;
  for (const kind of ENTITY_KINDS) total += changes[kind]?.length ?? 0;
  return total;
}

test('pushes dirty rows in dependency order batches of 200 until exhausted, including local mutation during push', async () => {
  const repo = new InMemoryCanonicalRepository();

  for (const kind of ENTITY_KINDS) {
    for (let index = 0; index < 35; index += 1) {
      const row = buildEntity(kind, {
        id: `${kind}-${index + 1}`,
        updatedAt: (index + 1) * 10,
        dirty: 1,
        rev: 0,
      } as never) as AnyEntity;
      await repo.upsert(kind, row as never);
    }
  }

  const transport = new RecordingTransport({
    onPush: async (_request, pushIndex) => {
      if (pushIndex !== 0) return;
      const current = await repo.get('receipts', 'receipts-5');
      assert.ok(current);
      await repo.upsert('receipts', {
        ...current,
        total: 777,
        updatedAt: current.updatedAt + 5000,
        dirty: 1,
      });
    },
  });

  const result = await runSyncPass({
    repo,
    transport,
    blobs: new InMemoryBlobStore(),
    clock,
    logger,
    network,
  }, {
    pushBatchSize: 200,
    pullLimit: 200,
  });

  assert.ok(transport.pushes.length >= 2);
  assert.equal(countChanges(transport.pushes[0].changes), 200);
  assert.equal(result.pushed, 245);
  assert.equal(await repo.countDirty(), 0);

  const orderedKinds = Object.keys(transport.pushes[0].changes) as Array<(typeof ENTITY_KINDS)[number]>;
  const ranks = orderedKinds.map((kind) => ENTITY_KINDS.indexOf(kind));
  for (let index = 1; index < ranks.length; index += 1) {
    assert.ok(ranks[index] >= ranks[index - 1]);
  }
});

test('cheap status probe resets diverged cursor and pulls from zero when nothing is dirty', async () => {
  const repo = new InMemoryCanonicalRepository();
  await repo.setSyncState({ cursor: 99, epoch: 'epoch-1' });

  const transport = new RecordingTransport({
    statusReply: {
      cursor: 5,
      epoch: 'epoch-1',
      hasChanges: true,
      diverged: true,
    },
    pullPages: [
      {
        changes: {},
        cursor: 5,
        hasMore: false,
        epoch: 'epoch-1',
        serverTime: Date.now(),
      },
    ],
  });

  const result = await runSyncPass({
    repo,
    transport,
    blobs: new InMemoryBlobStore(),
    clock,
    logger,
    network,
  });

  assert.equal(transport.statusCalls, 1);
  assert.equal(transport.pullQueries.length, 1);
  assert.equal(transport.pullQueries[0].since, 0);
  assert.equal(result.resetCursor, true);
  assert.equal((await repo.getSyncState()).cursor, 5);
});

test('pulls globally paged interleaved kinds, including secrets arriving last page', async () => {
  const repo = new InMemoryCanonicalRepository();
  const interleaved = ENTITY_KINDS.map((kind, index) => buildEntity(kind, {
    id: `${kind}-remote`,
    rev: index + 1,
    dirty: 0,
    updatedAt: 1_000 + index,
  } as never) as AnyEntity);

  const transport = new RecordingTransport({
    statusReply: {
      hasChanges: true,
      diverged: false,
      epoch: 'epoch-1',
      cursor: 7,
    },
    pullPages: [
      {
        changes: {
          companies: [interleaved[0]],
          receipts: [interleaved[1]],
          items: [interleaved[2]],
          categories: [interleaved[3]],
          tags: [interleaved[4]],
          receiptTags: [interleaved[5]],
        },
        cursor: 6,
        hasMore: true,
        epoch: 'epoch-1',
        serverTime: Date.now(),
      },
      {
        changes: {
          secrets: [interleaved[6]],
        },
        cursor: 7,
        hasMore: false,
        epoch: 'epoch-1',
        serverTime: Date.now(),
      },
    ],
  });

  const result = await runSyncPass({
    repo,
    transport,
    blobs: new InMemoryBlobStore(),
    clock,
    logger,
    network,
  });

  assert.equal(transport.pushes.length, 0);
  assert.equal(result.pullProgress.pages, 2);
  assert.equal(result.pulled, 7);
  assert.ok(await repo.get('secrets', 'secrets-remote'));
  for (const kind of ENTITY_KINDS) {
    const counts = await repo.countByKind();
    assert.equal(counts[kind], 1);
  }
});

test('shared in-flight wrapper returns the same promise for concurrent callers', async () => {
  let calls = 0;
  const shared = createSharedInFlight(async () => {
    calls += 1;
    return { ok: true, calls };
  });

  const [a, b, c] = await Promise.all([shared(), shared(), shared()]);
  assert.equal(calls, 1);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);
  assert.equal(c.calls, 1);

  await shared();
  assert.equal(calls, 2);
});
