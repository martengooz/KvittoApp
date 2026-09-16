import { ENTITY_KINDS, changeSetSize, type AnyEntity, type ChangeSet, type EntityKind } from '@kvitto/shared/domain';

import type { SyncTransportPort } from '../ports/sync.js';
import type {
  BlobStorePort,
  CanonicalRepositoryPort,
  Clock,
  Logger,
  NetworkPort,
  PullProgress,
  RevisionCursor,
} from '../ports/types.js';
import { makeChangeSetFromDirty } from '../fakes/memory.js';

export interface SyncEnginePorts {
  repo: CanonicalRepositoryPort;
  transport: SyncTransportPort;
  blobs: BlobStorePort;
  clock: Clock;
  logger: Logger;
  network: NetworkPort;
  downloadPlanner?: BlobDownloadPlannerPort;
}

export interface BlobDownloadPlan {
  eagerIds: string[];
  deferredIds: string[];
}

export interface BlobDownloadPlannerPort {
  plan(limit: number): Promise<BlobDownloadPlan>;
  markDownloaded?(id: string): Promise<void>;
  markDeferred?(ids: string[]): Promise<void>;
}

export interface SyncRunResult {
  pushed: number;
  pulled: number;
  uploadedBlobs: number;
  downloadedBlobs: number;
  deferredBlobDownloads: number;
  cursor: RevisionCursor;
  pullProgress: PullProgress;
  resetCursor: boolean;
}

export interface SyncRunOptions {
  pushBatchSize?: number;
  pullLimit?: number;
  blobUploadLimit?: number;
  blobDownloadLimit?: number;
}

export async function runSyncPass(ports: SyncEnginePorts, options: SyncRunOptions = {}): Promise<SyncRunResult> {
  const pushBatchSize = options.pushBatchSize ?? 200;
  const pullLimit = options.pullLimit ?? 200;
  const blobUploadLimit = options.blobUploadLimit ?? 12;
  const blobDownloadLimit = options.blobDownloadLimit ?? blobUploadLimit;

  if (!ports.network.isOnline()) {
    ports.logger.info('Skipping sync while offline');
    const cursor = await ports.repo.getSyncState();
    return {
      pushed: 0,
      pulled: 0,
      uploadedBlobs: 0,
      downloadedBlobs: 0,
      deferredBlobDownloads: 0,
      cursor,
      pullProgress: { pages: 0, records: 0 },
      resetCursor: false,
    };
  }

  const dirtyCountAtStart = await ports.repo.countDirty();
  let pushed = 0;
  let skipPull = false;
  let resetCursor = false;

  if (dirtyCountAtStart > 0) {
    pushed = await pushDirtyInBatches(ports, pushBatchSize);
  } else {
    const state = await ports.repo.getSyncState();
    const status = await ports.transport.status(state.cursor);
    if (status.epoch !== state.epoch || status.diverged === true) {
      await ports.repo.setSyncState({ cursor: 0, epoch: status.epoch });
      resetCursor = true;
    } else if (!status.hasChanges) {
      skipPull = true;
    }
  }

  const pullResult = skipPull
    ? { pages: 0, records: 0, resetCursor: false }
    : await pullAllPages(ports, pullLimit);

  const pending = await ports.blobs.listPendingUpload(blobUploadLimit);
  if (pending.length > 0) {
    await ports.transport.uploadBlobs(pending.map((blob) => blob.id));
    for (const blob of pending) {
      await ports.blobs.markUploaded(blob.id);
    }
  }

  let downloadedBlobs = 0;
  let deferredBlobDownloads = 0;
  if (ports.downloadPlanner) {
    const plan = await ports.downloadPlanner.plan(blobDownloadLimit);
    const eager = uniqueIds(plan.eagerIds).slice(0, blobDownloadLimit);
    const deferred = uniqueIds(plan.deferredIds).filter((id) => !eager.includes(id));

    if (eager.length > 0) {
      await ports.transport.downloadBlobs(eager);
      downloadedBlobs = eager.length;
      if (ports.downloadPlanner.markDownloaded) {
        for (const id of eager) {
          await ports.downloadPlanner.markDownloaded(id);
        }
      }
    }

    if (deferred.length > 0) {
      deferredBlobDownloads = deferred.length;
      if (ports.downloadPlanner.markDeferred) {
        await ports.downloadPlanner.markDeferred(deferred);
      }
    }
  }

  return {
    pushed,
    pulled: pullResult.records,
    uploadedBlobs: pending.length,
    downloadedBlobs,
    deferredBlobDownloads,
    cursor: await ports.repo.getSyncState(),
    pullProgress: pullResult,
    resetCursor: resetCursor || pullResult.resetCursor,
  };
}

async function pushDirtyInBatches(ports: SyncEnginePorts, limit: number): Promise<number> {
  let markedCleanTotal = 0;

  // Keep draining dirty records so edits that happen mid-pass are not lost.
  for (let pass = 0; pass < 100; pass += 1) {
    const snapshots = await ports.repo.listDirty(limit);
    if (snapshots.length === 0) break;

    const ordered = orderByDependencyThenTime(snapshots);
    const request: ChangeSet = makeChangeSetFromDirty(ordered);
    const response = await ports.transport.push({
      deviceId: 'device-local',
      protocolVersion: 2,
      changes: request,
    });

    const snapshotByKey = new Map(ordered.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    for (const result of response.results) {
      if (result.outcome !== 'applied' && result.outcome !== 'stale') continue;
      const snapshot = snapshotByKey.get(`${result.kind}:${result.id}`);
      if (!snapshot) continue;
      const didClean = await ports.repo.markCleanIfUpdatedAtMatches(snapshot, result.rev);
      if (didClean) markedCleanTotal += 1;
    }
  }

  return markedCleanTotal;
}

async function pullAllPages(ports: SyncEnginePorts, pullLimit: number): Promise<{ pages: number; records: number; resetCursor: boolean }> {
  let state = await ports.repo.getSyncState();
  let pages = 0;
  let records = 0;
  let resetCursor = false;

  for (;;) {
    const page = await ports.transport.pull({ since: state.cursor, limit: pullLimit });

    if (page.epoch && page.epoch !== state.epoch) {
      // Reset cursor only; local rows remain in place for conservative reconciliation.
      state = { cursor: 0, epoch: page.epoch };
      await ports.repo.setSyncState(state);
      resetCursor = true;
      continue;
    }

    const normalized = normalizeGlobalOrder(page.changes);
    const pageWork = async (): Promise<void> => {
      const applied = await ports.repo.applyIncoming(normalized);
      records += applied.applied + applied.merged;
      pages += 1;

      state = { cursor: page.cursor, epoch: page.epoch ?? state.epoch };
      await ports.repo.setSyncState(state);
    };

    await runTransactionLike(ports.repo, pageWork);

    if (!page.hasMore) break;
  }

  return { pages, records, resetCursor };
}

function normalizeGlobalOrder(changes: ChangeSet): Partial<Record<EntityKind, AnyEntity[]>> {
  const merged: { kind: EntityKind; row: AnyEntity }[] = [];
  for (const kind of ENTITY_KINDS) {
    for (const row of changes[kind] ?? []) merged.push({ kind, row });
  }

  const kindRank = new Map(ENTITY_KINDS.map((kind, index) => [kind, index]));

  merged.sort((a, b) => {
    if (a.row.rev !== b.row.rev) return a.row.rev - b.row.rev;
    if (a.kind !== b.kind) return (kindRank.get(a.kind) ?? 0) - (kindRank.get(b.kind) ?? 0);
    return a.row.id.localeCompare(b.row.id);
  });

  const out: Partial<Record<EntityKind, AnyEntity[]>> = {};
  for (const entry of merged) {
    const list = out[entry.kind] ?? [];
    list.push(entry.row);
    out[entry.kind] = list;
  }
  return out;
}

export function countChangeSetRecords(changes: ChangeSet): number {
  return changeSetSize(changes);
}

function orderByDependencyThenTime<T extends { kind: EntityKind; updatedAt: number; id: string }>(rows: T[]): T[] {
  const rank = new Map(ENTITY_KINDS.map((kind, index) => [kind, index]));
  return [...rows].sort((a, b) => {
    const byKind = (rank.get(a.kind) ?? 0) - (rank.get(b.kind) ?? 0);
    if (byKind !== 0) return byKind;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.id.localeCompare(b.id);
  });
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

async function runTransactionLike(
  repo: CanonicalRepositoryPort,
  work: () => Promise<void>,
): Promise<void> {
  const transactional = repo as CanonicalRepositoryPort & { runInTransaction?: <T>(fn: () => Promise<T>) => Promise<T> };
  if (typeof transactional.runInTransaction === 'function') {
    await transactional.runInTransaction(work);
    return;
  }
  await work();
}
