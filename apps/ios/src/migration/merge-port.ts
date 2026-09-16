import { planImportMerge, type ArchiveEntityKind, type ConflictResolver, type SyncLikeEntity } from '@kvitto/archive';

import type { CanonicalByIdMap, EntityMergePort, MergeBatch, MergeEntity, RepoWithTransaction } from './types';

export class RepositoryTransactionMergePort implements EntityMergePort {
  async merge(repository: RepoWithTransaction, batches: readonly MergeBatch[]): Promise<void> {
    const run = repository.runInTransaction
      ? (work: () => Promise<void>) => repository.runInTransaction!(work)
      : (work: () => Promise<void>) => work();

    await run(async () => {
      for (const batch of batches) {
        for (const entity of batch.creates) {
          await repository.upsert(batch.kind, entity as never);
        }
        for (const entity of batch.updates) {
          await repository.upsert(batch.kind, entity as never);
        }
      }
    });
  }
}

export function buildMergeBatch(
  kind: ArchiveEntityKind,
  imported: readonly MergeEntity[],
  existingById: CanonicalByIdMap,
  resolver?: ConflictResolver<SyncLikeEntity>,
): MergeBatch {
  const existingForMerge = existingById as unknown as ReadonlyMap<string, SyncLikeEntity>;
  const plan = planImportMerge(imported, existingForMerge, resolver);
  return {
    kind,
    creates: [...plan.creates] as MergeEntity[],
    updates: [...plan.updates] as MergeEntity[],
    noops: [...plan.noops],
  };
}
