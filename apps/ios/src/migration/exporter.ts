import {
  ARCHIVE_ENTITY_KINDS,
  canonicalBlobPath,
  canonicalManifest,
  preflightArchive,
  shouldExportEntityKind,
  type ArchiveEntityKind,
  type ArchiveEntrySource,
  type BlobMetadataRecord,
} from '@kvitto/archive';
import type { EntityKind } from '@kvitto/shared/domain';

import type { FileBackedZipWriter } from './types';

const encoder = new TextEncoder();

export interface ExportBlobSource {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  role: 'processed' | 'original' | 'thumb';
  open(): AsyncIterable<Uint8Array>;
}

export interface MigrationExportDataSource {
  listEntities(kind: ArchiveEntityKind): Promise<Record<string, unknown>[]>;
  listBlobs(): Promise<ExportBlobSource[]>;
  getRedactedSettings(): Promise<Record<string, unknown>>;
}

export interface NativeZipCapability {
  supported: boolean;
  mode: 'native-zip' | 'missing-wiring';
  reason?: string;
}

export interface MigrationExportPlan {
  capability: NativeZipCapability;
  estimatedEntries: number;
}

function streamJson(value: unknown): AsyncIterable<Uint8Array> {
  return (async function* bytes(): AsyncIterable<Uint8Array> {
    yield encoder.encode(JSON.stringify(value));
  })();
}

function streamNdjson(rows: readonly unknown[]): AsyncIterable<Uint8Array> {
  return (async function* bytes(): AsyncIterable<Uint8Array> {
    for (const row of rows) {
      yield encoder.encode(`${JSON.stringify(row)}\n`);
    }
  })();
}

function isExportable(kind: ArchiveEntityKind): kind is Extract<ArchiveEntityKind, EntityKind> {
  return shouldExportEntityKind(kind);
}

function blobRole(role: ExportBlobSource['role']): BlobMetadataRecord['role'] {
  return role === 'thumb' ? 'thumbnail' : role;
}

export async function writeArchiveExportToZipWriter(
  writer: FileBackedZipWriter,
  source: MigrationExportDataSource,
): Promise<{ blobCount: number }> {
  const manifest = canonicalManifest();
  await writer.addEntry(manifest.settingsPath, streamJson(await source.getRedactedSettings()));

  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const entityPath = manifest.entityStreams[kind];
    if (!isExportable(kind)) {
      await writer.addEntry(entityPath, streamNdjson([]));
      continue;
    }
    await writer.addEntry(entityPath, streamNdjson(await source.listEntities(kind)));
  }

  const blobs = await source.listBlobs();
  const metadata: BlobMetadataRecord[] = blobs.map((blob) => ({
    sha256: blob.id,
    mimeType: blob.mimeType,
    width: blob.width ?? 0,
    height: blob.height ?? 0,
    sizeBytes: blob.byteSize,
    role: blobRole(blob.role),
  }));

  await writer.addEntry(manifest.blobMetadataPath, streamNdjson(metadata));
  for (const blob of blobs) {
    await writer.addEntry(canonicalBlobPath(blob.id), blob.open());
  }

  await writer.addEntry('manifest.json', streamJson(manifest));
  return { blobCount: blobs.length };
}

export function buildNativeExportPlan(capability: NativeZipCapability): MigrationExportPlan {
  return {
    capability,
    estimatedEntries: ARCHIVE_ENTITY_KINDS.length + 3,
  };
}

export async function validateArchiveEntrySource(source: ArchiveEntrySource): Promise<boolean> {
  const report = await preflightArchive(source);
  return report.ok && report.issues.every((issue) => issue.severity !== 'error');
}
