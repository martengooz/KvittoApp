import type {
  ConflictResolver,
  ConflictWinner,
  ImportMergeOutcome,
  ImportMergePlan,
  SyncLikeEntity,
} from './types.js';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${stableStringify(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export function defaultConflictResolver<TEntity extends SyncLikeEntity>(
  local: TEntity,
  imported: TEntity,
): ConflictWinner {
  if (imported.updatedAt > local.updatedAt) return 'imported';
  if (imported.updatedAt < local.updatedAt) return 'local';
  return stableStringify(imported) > stableStringify(local) ? 'imported' : 'local';
}

export function normalizeNewImportedEntity<TEntity extends SyncLikeEntity>(imported: TEntity): TEntity {
  return {
    ...imported,
    rev: 0,
    dirty: 1,
  };
}

export function mergeImportedEntity<TEntity extends SyncLikeEntity>(
  local: TEntity | undefined,
  imported: TEntity,
  conflictResolver: ConflictResolver<TEntity> = defaultConflictResolver,
): ImportMergeOutcome<TEntity> {
  if (!local) {
    const merged = normalizeNewImportedEntity(imported);
    return { merged, changed: true };
  }

  const winner = conflictResolver(local, imported);
  if (winner === 'local') {
    return { merged: local, changed: false };
  }

  const merged: TEntity = {
    ...imported,
    rev: local.rev,
    dirty: 1,
  };

  const changed = stableStringify(merged) !== stableStringify(local);
  return { merged, changed };
}

export function planImportMerge<TEntity extends SyncLikeEntity>(
  importedEntities: readonly TEntity[],
  existingById: ReadonlyMap<string, TEntity>,
  conflictResolver: ConflictResolver<TEntity> = defaultConflictResolver,
): ImportMergePlan<TEntity> {
  const creates: TEntity[] = [];
  const updates: TEntity[] = [];
  const noops: string[] = [];

  for (const imported of importedEntities) {
    const local = existingById.get(imported.id);
    const outcome = mergeImportedEntity(local, imported, conflictResolver);

    if (!local) {
      creates.push(outcome.merged);
      continue;
    }

    if (!outcome.changed) {
      noops.push(imported.id);
      continue;
    }

    updates.push(outcome.merged);
  }

  return { creates, updates, noops };
}
