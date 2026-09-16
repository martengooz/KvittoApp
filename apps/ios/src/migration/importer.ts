import {
  ARCHIVE_ENTITY_KINDS,
  BLOB_METADATA_PATH,
  canonicalBlobPath,
  planImportMerge,
  type ArchiveEntityKind,
  type ArchiveEntry,
  type ParsedArchiveManifest,
  type SyncLikeEntity,
} from '@kvitto/archive';

import { assertPreflightOk, runArchivePreflight } from './preflight';
import { RepositoryTransactionMergePort } from './merge-port';
import type {
  ArchiveImportInput,
  ArchiveImportResult,
  LoadedArchivePayload,
  MergeEntity,
  MergeBatch,
  RepoWithTransaction,
} from './types';

const decoder = new TextDecoder();

async function readUtf8(entry: ArchiveEntry): Promise<string> {
  let out = '';
  for await (const chunk of entry.open()) {
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode(new Uint8Array(0));
  return out;
}

async function readNdjson(entry: ArchiveEntry): Promise<unknown[]> {
  const text = await readUtf8(entry);
  const rows: unknown[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

async function collectEntries(source: AsyncIterable<ArchiveEntry>): Promise<Map<string, ArchiveEntry>> {
  const byPath = new Map<string, ArchiveEntry>();
  for await (const entry of source) {
    byPath.set(entry.path, entry);
  }
  return byPath;
}

async function listAllByKind(repository: RepoWithTransaction, kind: ArchiveEntityKind): Promise<Map<string, SyncLikeEntity>> {
  const byId = new Map<string, SyncLikeEntity>();
  let cursor = -1;

  while (true) {
    const page = await repository.list(kind, { cursor, limit: 500 });
    for (const row of page.items) {
      byId.set(row.id, row as unknown as SyncLikeEntity);
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }

  return byId;
}

async function loadPayloadFromManifest(
  manifest: ParsedArchiveManifest,
  entriesByPath: ReadonlyMap<string, ArchiveEntry>,
): Promise<LoadedArchivePayload> {
  const entities = {
    companies: [],
    receipts: [],
    items: [],
    categories: [],
    tags: [],
    receiptTags: [],
    secrets: [],
  } as Record<ArchiveEntityKind, MergeEntity[]>;

  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const entry = entriesByPath.get(manifest.entityStreams[kind]);
    if (!entry) {
      throw new Error(`Missing entity stream after preflight: ${kind}`);
    }

    const rows = await readNdjson(entry);
    entities[kind] = rows as MergeEntity[];
  }

  const blobMetadataEntry = entriesByPath.get(manifest.blobMetadataPath) ?? entriesByPath.get(BLOB_METADATA_PATH);
  if (!blobMetadataEntry) {
    throw new Error('Missing blob metadata stream after preflight.');
  }
  const blobMetadata = (await readNdjson(blobMetadataEntry)) as LoadedArchivePayload['blobMetadata'];

  const blobEntriesBySha = new Map<string, ArchiveEntry>();
  for (const meta of blobMetadata) {
    const entry = entriesByPath.get(canonicalBlobPath(meta.sha256));
    if (!entry) {
      throw new Error(`Missing blob entry after preflight: ${meta.sha256}`);
    }
    blobEntriesBySha.set(meta.sha256, entry);
  }

  let settings: Record<string, unknown> | null = null;
  const settingsEntry = entriesByPath.get(manifest.settingsPath);
  if (settingsEntry) {
    settings = JSON.parse(await readUtf8(settingsEntry)) as Record<string, unknown>;
  }

  return {
    entities,
    blobMetadata,
    blobEntriesBySha,
    settings,
  };
}

function buildBatches(payload: LoadedArchivePayload, existing: Record<ArchiveEntityKind, Map<string, SyncLikeEntity>>,
  resolvers: ArchiveImportInput['conflictResolvers']): MergeBatch[] {
  const batches: MergeBatch[] = [];

  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const imported = payload.entities[kind];
    const byId = existing[kind];
    const resolver = resolvers?.[kind];
    const plan = planImportMerge(imported, byId, resolver);
    batches.push({
      kind,
      creates: [...plan.creates],
      updates: [...plan.updates],
      noops: [...plan.noops],
    });
  }

  return batches;
}

export async function importArchiveWithStaging(input: ArchiveImportInput): Promise<ArchiveImportResult> {
  const preflight = await runArchivePreflight(input.sourceFactory);
  assertPreflightOk(preflight);

  if (!preflight.manifest) {
    throw new Error('Archive has no manifest after successful preflight.');
  }

  const source = await input.sourceFactory.create();
  const entriesByPath = await collectEntries(source.entries());
  const payload = await loadPayloadFromManifest(preflight.manifest, entriesByPath);

  const existingByKind: Record<ArchiveEntityKind, Map<string, SyncLikeEntity>> = {
    companies: await listAllByKind(input.repository, 'companies'),
    receipts: await listAllByKind(input.repository, 'receipts'),
    items: await listAllByKind(input.repository, 'items'),
    categories: await listAllByKind(input.repository, 'categories'),
    tags: await listAllByKind(input.repository, 'tags'),
    receiptTags: await listAllByKind(input.repository, 'receiptTags'),
    secrets: await listAllByKind(input.repository, 'secrets'),
  };

  const batches = buildBatches(payload, existingByKind, input.conflictResolvers);

  const stagingId = await input.blobStaging.begin();
  let stagedCount = 0;

  try {
    for (const blob of payload.blobMetadata) {
      const entry = payload.blobEntriesBySha.get(blob.sha256);
      if (!entry) {
        throw new Error(`Blob metadata exists without entry: ${blob.sha256}`);
      }
      await input.blobStaging.stageBlob(stagingId, blob.sha256, entry.open(), blob.sizeBytes);
      stagedCount += 1;
    }

    const mergePort = new RepositoryTransactionMergePort();
    await mergePort.merge(input.repository, batches);

    if (payload.settings && input.settings) {
      await input.settings.applyImportedSettings(payload.settings);
    }

    await input.blobStaging.commit(stagingId);

    const merged = {
      creates: batches.reduce((sum, batch) => sum + batch.creates.length, 0),
      updates: batches.reduce((sum, batch) => sum + batch.updates.length, 0),
      noops: batches.reduce((sum, batch) => sum + batch.noops.length, 0),
    };

    input.diagnostics?.info('migration.import.completed', {
      creates: merged.creates,
      updates: merged.updates,
      noops: merged.noops,
      stagedBlobs: stagedCount,
    });

    return {
      preflight,
      stagingId,
      merged,
      blob: {
        staged: stagedCount,
        committed: stagedCount,
      },
    };
  } catch (error) {
    await input.blobStaging.rollback(stagingId);
    input.diagnostics?.error('migration.import.rollback', {
      stagingId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
