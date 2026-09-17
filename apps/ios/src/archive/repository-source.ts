import { ARCHIVE_ENTITY_KINDS, type ArchiveEntityKind } from '@kvitto/archive';

import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';
import type { IosDataRepository } from '../data/repository';
import type { ArchiveExportBlob, ArchiveExportSource } from './export';

/** Upper bound on blobs in one export, so a corrupt store cannot hang it. */
const MAX_BLOBS = 100_000;
const PAGE_SIZE = 500;

export type ExportSourceNativePort = Pick<KvittoNativeFacade, 'listAllBlobMetadata'>;

function isExportableKind(kind: string): kind is ArchiveEntityKind {
  return (ARCHIVE_ENTITY_KINDS as readonly string[]).includes(kind);
}

/**
 * The live database and blob store, shaped as an export source.
 *
 * Entities are paged rather than read in one query, and blobs are described by
 * the file they already occupy - the export writer takes file URIs, so a
 * receipt image is never read into JavaScript on its way into the archive.
 */
export function createRepositoryExportSource(
  repository: IosDataRepository,
  native: ExportSourceNativePort,
  getSettings: () => Promise<unknown>,
): ArchiveExportSource {
  return {
    async listEntities(kind: ArchiveEntityKind): Promise<Record<string, unknown>[]> {
      if (!isExportableKind(kind)) return [];

      const out: Record<string, unknown>[] = [];
      // `list` pages by revision and `rev > cursor`, so the first page needs a
      // cursor below every row's rev, not 0.
      let cursor = -1;
      while (true) {
        const page = await repository.list(kind, { cursor, limit: PAGE_SIZE });
        for (const row of page.items) {
          // Tombstones are exported too: section 14 asks for deletions to
          // travel with the archive, not to be silently dropped.
          out.push(row as unknown as Record<string, unknown>);
        }
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      return out;
    },

    async listBlobs(): Promise<ArchiveExportBlob[]> {
      const records = await native.listAllBlobMetadata(MAX_BLOBS);
      return records
        // A record without a digest cannot be addressed as `blobs/<sha256>`,
        // and shipping it under a made-up name would fail import verification.
        .filter((record): record is typeof record & { sha256Id: string } => Boolean(record.sha256Id))
        .map((record) => ({
        sha256: record.sha256Id,
        mimeType: record.mimeType,
        width: record.width,
        height: record.height,
        sizeBytes: record.byteSize,
        role: record.role,
        fileUri: record.uri,
      }));
    },

    getSettings,
  };
}
