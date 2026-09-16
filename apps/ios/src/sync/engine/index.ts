import { createExternalStore, createSharedInFlight, runSyncPass, type BlobDownloadPlan, type SyncEnginePorts, type SyncRunOptions, type SyncRunResult } from '@kvitto/client-core/sync';
import type { RevisionCursor } from '@kvitto/client-core/ports';

export interface ReceiptImageRefs {
  thumbId: string | null;
  imageId: string | null;
}

export interface SyncImagePlannerPort {
  listReceiptImageRefs(): Promise<ReceiptImageRefs[]>;
  hasBlob(id: string): Promise<boolean>;
  markDownloaded?(id: string): Promise<void>;
  markDeferred?(ids: string[]): Promise<void>;
}

export interface SyncTriggerAdapter {
  attach(trigger: (reason: string) => void): () => void;
}

export interface SyncEngineState {
  status: 'idle' | 'syncing' | 'offline' | 'error';
  inFlight: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  pendingDirty: number;
  cursor: RevisionCursor;
}

export interface IosSyncEngine {
  run(reason?: string): Promise<SyncRunResult>;
  getSnapshot(): SyncEngineState;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface IosSyncEngineOptions {
  now?: () => number;
  runOptions?: SyncRunOptions;
  triggers?: SyncTriggerAdapter;
  imagePlanner?: SyncImagePlannerPort;
}

export function createIosSyncEngine(
  ports: SyncEnginePorts,
  options: IosSyncEngineOptions = {},
): IosSyncEngine {
  const now = options.now ?? (() => Date.now());
  const state = createExternalStore<SyncEngineState>({
    status: ports.network.isOnline() ? 'idle' : 'offline',
    inFlight: false,
    lastSuccessAt: null,
    lastError: null,
    pendingDirty: 0,
    cursor: { cursor: 0, epoch: 'epoch-1' },
  });

  let runReason = 'manual';

  const runOnce = async (): Promise<SyncRunResult> => {
    const pendingBefore = await ports.repo.countDirty();
    const cursorBefore = await ports.repo.getSyncState();

    state.setSnapshot({
      ...state.getSnapshot(),
      status: ports.network.isOnline() ? 'syncing' : 'offline',
      inFlight: true,
      lastError: null,
      pendingDirty: pendingBefore,
      cursor: cursorBefore,
    });

    try {
      const withPlanner: SyncEnginePorts = options.imagePlanner
        ? {
          ...ports,
          downloadPlanner: {
            plan: (limit) => planBlobDownloads(options.imagePlanner!, limit),
            markDownloaded: options.imagePlanner.markDownloaded
              ? (id) => options.imagePlanner!.markDownloaded!(id)
              : undefined,
            markDeferred: options.imagePlanner.markDeferred
              ? (ids) => options.imagePlanner!.markDeferred!(ids)
              : undefined,
          },
        }
        : ports;

      const result = await runSyncPass(withPlanner, options.runOptions);
      const pendingAfter = await ports.repo.countDirty();

      state.setSnapshot({
        status: ports.network.isOnline() ? 'idle' : 'offline',
        inFlight: false,
        lastSuccessAt: now(),
        lastError: null,
        pendingDirty: pendingAfter,
        cursor: result.cursor,
      });

      ports.logger.info('sync.engine.pass-complete', {
        reason: runReason,
        pushed: result.pushed,
        pulled: result.pulled,
        uploadedBlobs: result.uploadedBlobs,
        downloadedBlobs: result.downloadedBlobs,
      });
      return result;
    } catch (error) {
      const pendingAfter = await ports.repo.countDirty();
      const cursorAfter = await ports.repo.getSyncState();
      state.setSnapshot({
        ...state.getSnapshot(),
        status: ports.network.isOnline() ? 'error' : 'offline',
        inFlight: false,
        lastError: error instanceof Error ? error.message : String(error),
        pendingDirty: pendingAfter,
        cursor: cursorAfter,
      });
      throw error;
    }
  };

  const runShared = createSharedInFlight(runOnce);

  const run = (reason = 'manual'): Promise<SyncRunResult> => {
    runReason = reason;
    return runShared();
  };

  const detachTriggers = options.triggers?.attach((reason) => {
    void run(reason).catch(() => {
      // The engine snapshot captures the error state for observers.
    });
  });

  return {
    run,
    getSnapshot: () => state.getSnapshot(),
    subscribe: (listener) => state.subscribe(listener),
    dispose: () => {
      detachTriggers?.();
    },
  };
}

export async function planBlobDownloads(planner: SyncImagePlannerPort, limit: number): Promise<BlobDownloadPlan> {
  if (limit <= 0) return { eagerIds: [], deferredIds: [] };

  const refs = await planner.listReceiptImageRefs();
  const thumbs = new Set<string>();
  const processed = new Set<string>();

  for (const receipt of refs) {
    if (receipt.thumbId) thumbs.add(receipt.thumbId);
    if (receipt.imageId) processed.add(receipt.imageId);
  }

  const ordered = [...thumbs, ...[...processed].filter((id) => !thumbs.has(id))];
  const wanted: string[] = [];
  for (const id of ordered) {
    if (await planner.hasBlob(id)) continue;
    wanted.push(id);
  }

  return {
    eagerIds: wanted.slice(0, limit),
    deferredIds: wanted.slice(limit),
  };
}
