/** @jest-environment node */

import type {
  BlobStorePort,
  CanonicalRepositoryPort,
  DirtySnapshot,
  Logger,
  RevisionCursor,
  SyncTransportPort,
} from '@kvitto/client-core/ports';
import type { AnyEntity, ChangeSet, PairRequest, PairResponse, PullQuery, PullResponse, PushRequest, PushResponse, SyncStatusResponse, WhoAmIResponse } from '@kvitto/shared/domain';

import { createIosSyncEngine, planBlobDownloads, type SyncTriggerAdapter } from '../src/sync/engine';

class RepoStub implements CanonicalRepositoryPort {
  private readonly state: RevisionCursor = { cursor: 0, epoch: 'epoch-1' };

  async get(): Promise<null> {
    return null;
  }

  async upsert(_kind: never, entity: never): Promise<never> {
    return entity;
  }

  async tombstone(): Promise<null> {
    return null;
  }

  async list(): Promise<{ items: never[]; nextCursor: number; hasMore: boolean }> {
    return { items: [], nextCursor: 0, hasMore: false };
  }

  async listDirty(_limit: number): Promise<DirtySnapshot[]> {
    return [];
  }

  async markCleanIfUpdatedAtMatches(): Promise<boolean> {
    return false;
  }

  async dirtyAllAndResetRev(): Promise<void> {}

  async getSyncState(): Promise<RevisionCursor> {
    return { ...this.state };
  }

  async setSyncState(state: RevisionCursor): Promise<void> {
    this.state.cursor = state.cursor;
    this.state.epoch = state.epoch;
  }

  async applyIncoming(): Promise<{ applied: number; merged: number; skippedStale: number }> {
    return { applied: 0, merged: 0, skippedStale: 0 };
  }

  async countByKind(): Promise<Record<any, number>> {
    return {
      companies: 0,
      receipts: 0,
      items: 0,
      categories: 0,
      tags: 0,
      receiptTags: 0,
      secrets: 0,
    };
  }

  async countDirty(): Promise<number> {
    return 0;
  }

  async getReceipt(): Promise<null> {
    return null;
  }
}

class BlobStub implements BlobStorePort {
  async put(descriptor: any): Promise<any> {
    return { ...descriptor, createdAt: Date.now() };
  }

  async get(): Promise<null> {
    return null;
  }

  async markUploaded(): Promise<void> {}

  async listPendingUpload(): Promise<any[]> {
    return [];
  }
}

class TransportStub implements SyncTransportPort {
  public statusCalls = 0;

  async pair(request: PairRequest): Promise<PairResponse> {
    return {
      token: 'token',
      accountId: 'acc-1',
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      protocolVersion: 2,
      serverTime: Date.now(),
    };
  }

  async whoAmI(): Promise<WhoAmIResponse> {
    return {
      deviceId: 'dev-1',
      deviceName: 'Phone',
      accountId: 'acc-1',
      protocolVersion: 2,
      serverTime: Date.now(),
      aiProxyEnabled: false,
      aiProxyModels: [],
    };
  }

  async status(_since: number): Promise<SyncStatusResponse> {
    this.statusCalls += 1;
    return {
      cursor: 0,
      epoch: 'epoch-1',
      hasChanges: false,
      diverged: false,
      serverTime: Date.now(),
    };
  }

  async push(_request: PushRequest): Promise<PushResponse> {
    return {
      results: [],
      cursor: 0,
      serverTime: Date.now(),
    };
  }

  async pull(_query: PullQuery): Promise<PullResponse> {
    return {
      changes: {} as ChangeSet,
      cursor: 0,
      hasMore: false,
      epoch: 'epoch-1',
      serverTime: Date.now(),
    };
  }

  async uploadBlobs(_ids: string[]): Promise<void> {}

  async downloadBlobs(_ids: string[]): Promise<void> {}
}

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('iOS sync engine', () => {
  test('shares one in-flight pass across concurrent callers', async () => {
    const repo = new RepoStub();
    const transport = new TransportStub();

    const engine = createIosSyncEngine({
      repo,
      transport,
      blobs: new BlobStub(),
      clock: { now: () => Date.now() },
      logger,
      network: { isOnline: () => true },
    });

    const [first, second] = await Promise.all([
      engine.run('manual'),
      engine.run('trigger'),
    ]);

    expect(transport.statusCalls).toBe(1);
    expect(first.pulled).toBe(0);
    expect(second.pulled).toBe(0);
    expect(engine.getSnapshot().status).toBe('idle');

    engine.dispose();
  });

  test('trigger adapter can request sync runs and updates external-store state', async () => {
    const repo = new RepoStub();
    const transport = new TransportStub();

    let onTrigger: ((reason: string) => void) | null = null;
    const triggers: SyncTriggerAdapter = {
      attach(trigger) {
        onTrigger = trigger;
        return () => {
          onTrigger = null;
        };
      },
    };

    const engine = createIosSyncEngine({
      repo,
      transport,
      blobs: new BlobStub(),
      clock: { now: () => Date.now() },
      logger,
      network: { isOnline: () => true },
    }, {
      triggers,
      now: () => 12345,
    });

    const states: string[] = [];
    const unsubscribe = engine.subscribe(() => {
      states.push(engine.getSnapshot().status);
    });

    const fireTrigger = onTrigger as ((reason: string) => void) | null;
    fireTrigger?.('data:changed');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(engine.getSnapshot().lastSuccessAt).toBe(12345);
    expect(states.includes('syncing') || states.includes('idle')).toBe(true);

    unsubscribe();
    engine.dispose();
  });

  test('blob planner prioritises thumbnails before processed and defers remaining', async () => {
    const plan = await planBlobDownloads({
      async listReceiptImageRefs() {
        return [
          { thumbId: 'thumb-1', imageId: 'img-1' },
          { thumbId: 'thumb-2', imageId: 'img-2' },
          { thumbId: null, imageId: 'img-3' },
        ];
      },
      async hasBlob(id: string) {
        return id === 'img-2';
      },
    }, 2);

    expect(plan.eagerIds).toEqual(['thumb-1', 'thumb-2']);
    expect(plan.deferredIds).toEqual(['img-1', 'img-3']);
  });
});
