import { shouldExportEntityKind, type ArchiveEntityKind } from '@kvitto/archive';

import { getSettings } from '../core/settings.js';
import { db, SYNC_TABLES } from '../db/db.js';
import { type ArchiveEntrySink, type ArchiveExportDataSource, writeArchiveExport } from './archive-export-core.js';

function isExportableTableKind(kind: ArchiveEntityKind): kind is Exclude<ArchiveEntityKind, 'secrets'> {
  return shouldExportEntityKind(kind);
}

export async function writeArchiveExportFromDatabase(sink: ArchiveEntrySink): Promise<{ blobCount: number }> {
  const source: ArchiveExportDataSource = {
    getSettings,
    listEntities: async (kind) => {
      if (!isExportableTableKind(kind)) return [];
      const table = SYNC_TABLES[kind]();
      const rows = await table.toArray();
      return rows as unknown as Record<string, unknown>[];
    },
    listBlobs: async () => {
      const blobs = await db.blobs.toArray();
      return blobs.map((blob) => ({
        id: blob.id,
        mimeType: blob.mimeType,
        byteSize: blob.byteSize,
        width: blob.width,
        height: blob.height,
        role: blob.role,
        data: blob.data,
      }));
    },
  };

  return writeArchiveExport(sink, source);
}
