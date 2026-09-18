import {
  BLOB_METADATA_PATH,
  canonicalEntityPath,
  isValidSha256,
  planImportMerge,
  type ArchiveEntityKind,
  type ArchiveEntry,
  type ArchiveEntrySource,
  type SyncLikeEntity,
} from '@kvitto/archive';
import { ARCHIVE_ENTITY_KINDS } from '@kvitto/archive';
import type { EntityKind } from '@kvitto/shared/domain';

import type { CanonicalRecord } from '@kvitto/client-core/ports';
import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';
import type { IosDataRepository } from '../data/repository';

export type ApplyNativePort = Pick<
  KvittoNativeFacade,
  | 'extractArchiveEntry'
  | 'hashFileSha256'
  | 'storeContentAddressedFile'
  | 'makeScratchFileUri'
  | 'deleteScratchFile'
>;

export interface ArchiveApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  blobsStored: number;
  blobsAlreadyPresent: number;
}

export class ArchiveApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveApplyError';
  }
}

interface BlobMetadataLine {
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  role: string;
}

async function readText(entry: ArchiveEntry): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of entry.open()) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function parseNdjson(text: string, path: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ArchiveApplyError(`${path} line ${index + 1} is not valid JSON.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ArchiveApplyError(`${path} line ${index + 1} is not an object.`);
    }
    rows.push(parsed as Record<string, unknown>);
  }
  return rows;
}

function isSyncLike(row: Record<string, unknown>): row is SyncLikeEntity {
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.updatedAt === 'number' &&
    typeof row.deletedAt === 'number' &&
    typeof row.rev === 'number' &&
    (row.dirty === 0 || row.dirty === 1)
  );
}

/**
 * Applies an archive that has already passed preflight.
 *
 * The order here is the whole point, and it follows section 14 requirements
 * 7-10 rather than what would be convenient:
 *
 * 1. Blobs are extracted to **staging files outside the live blob directory**
 *    and their SHA-256 verified there. A blob is never written where the app
 *    would serve it until it is known to be the blob it claims to be.
 * 2. Entities are applied in **one transaction**, so a failure leaves the
 *    database exactly as it was.
 * 3. Blobs are promoted into the store **only after that transaction commits**.
 *    Promoting first would leave orphaned images behind on a failed import;
 *    promoting after leaves, at worst, receipts whose images arrive moments
 *    later - and a re-import fixes it, because the whole thing is idempotent.
 * 4. Staged files are removed on every path, success or failure.
 *
 * Re-running this with the same archive is a no-op: ids are preserved, the
 * merge rules resolve identical rows to `noops`, and content-addressed blobs
 * that already exist are skipped.
 */
export async function applyArchive(
  repository: IosDataRepository,
  native: ApplyNativePort,
  source: ArchiveEntrySource,
  archiveFileUri: string,
): Promise<ArchiveApplyResult> {
  const entityText = new Map<ArchiveEntityKind, string>();
  const blobPaths = new Map<string, string>();
  let metadataText: string | null = null;

  for await (const entry of source.entries()) {
    for (const kind of ARCHIVE_ENTITY_KINDS) {
      if (entry.path === canonicalEntityPath(kind)) entityText.set(kind, await readText(entry));
    }
    if (entry.path === BLOB_METADATA_PATH) metadataText = await readText(entry);
    if (entry.path.startsWith('blobs/')) {
      const sha = entry.path.slice('blobs/'.length);
      if (isValidSha256(sha)) blobPaths.set(sha, entry.path);
    }
  }

  const metadata = new Map<string, BlobMetadataLine>();
  if (metadataText !== null) {
    for (const row of parseNdjson(metadataText, BLOB_METADATA_PATH)) {
      const line = row as unknown as BlobMetadataLine;
      if (typeof line.sha256 === 'string' && isValidSha256(line.sha256)) {
        metadata.set(line.sha256, line);
      }
    }
  }

  // --- Stage and verify blobs, outside the live directory -------------------

  const staged: { sha256: string; uri: string; line: BlobMetadataLine }[] = [];
  const stagedUris: string[] = [];
  let blobsAlreadyPresent = 0;

  try {
    for (const [sha256, path] of blobPaths) {
      const line = metadata.get(sha256);
      if (!line) {
        throw new ArchiveApplyError(`${path} has no entry in ${BLOB_METADATA_PATH}.`);
      }

      const stagingUri = native.makeScratchFileUri('archive-import', 'bin');
      stagedUris.push(stagingUri);
      await native.extractArchiveEntry(archiveFileUri, path, stagingUri);

      // Requirement 5. The reader already checked the ZIP's own CRC, which says
      // the bytes survived the container; this says they are the bytes the
      // archive claims, which is a different question.
      const actual = await native.hashFileSha256(stagingUri);
      if (actual !== sha256) {
        throw new ArchiveApplyError(
          `${path} does not match its digest. expected=${sha256} actual=${actual}`,
        );
      }

      staged.push({ sha256, uri: stagingUri, line });
    }

    // --- Plan and apply entities in one transaction ------------------------

    const byKind = new Map<EntityKind, CanonicalRecord<EntityKind>[]>();
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const kind of ARCHIVE_ENTITY_KINDS) {
      const text = entityText.get(kind);
      if (text === undefined) continue;

      const rows = parseNdjson(text, canonicalEntityPath(kind));
      const imported: SyncLikeEntity[] = [];
      for (const row of rows) {
        if (!isSyncLike(row)) {
          throw new ArchiveApplyError(
            `${canonicalEntityPath(kind)} contains a row without valid sync fields.`,
          );
        }
        imported.push(row);
      }
      if (imported.length === 0) continue;

      const existing = await repository.mapAllByIdForImport(kind as EntityKind);
      const plan = planImportMerge(
        imported,
        existing as unknown as ReadonlyMap<string, SyncLikeEntity>,
      );

      created += plan.creates.length;
      updated += plan.updates.length;
      unchanged += plan.noops.length;

      const writes = [...plan.creates, ...plan.updates] as unknown as CanonicalRecord<EntityKind>[];
      if (writes.length > 0) byKind.set(kind as EntityKind, writes);
    }

    await repository.applyImportedEntities(byKind);

    // --- Promote blobs, only now that the entities are committed -----------

    let blobsStored = 0;
    for (const item of staged) {
      const record = await native.storeContentAddressedFile({
        sourceUri: item.uri,
        mimeType: item.line.mimeType,
        width: item.line.width,
        height: item.line.height,
        byteSize: item.line.sizeBytes,
        role: item.line.role as never,
      });
      if (record.sha256Id === item.sha256) blobsStored += 1;
      else blobsAlreadyPresent += 1;
    }

    return { created, updated, unchanged, blobsStored, blobsAlreadyPresent };
  } finally {
    for (const uri of stagedUris) {
      await native.deleteScratchFile(uri).catch(() => undefined);
    }
  }
}
