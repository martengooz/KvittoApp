import {
  ARCHIVE_ENTITY_KINDS,
  canonicalBlobPath,
  canonicalManifest,
  shouldExportEntityKind,
  type ArchiveEntityKind,
  type BlobMetadataRecord,
} from '@kvitto/archive';

import type { AppSettings } from '../core/settings';

const encoder = new TextEncoder();

export interface ArchiveEntrySink {
  addEntry: (path: string, bytes: AsyncIterable<Uint8Array>) => Promise<void>;
}

export interface ArchiveExportBlob {
  id: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  role: 'processed' | 'original' | 'thumb';
  data: {
    stream: () => ReadableStream<Uint8Array>;
  };
}

export interface ArchiveExportDataSource {
  getSettings: () => AppSettings;
  listEntities: (kind: ArchiveEntityKind) => Promise<Record<string, unknown>[]>;
  listBlobs: () => Promise<ArchiveExportBlob[]>;
}

export function redactSettingsForArchive(settings: AppSettings): Record<string, unknown> {
  return {
    ...settings,
    ai: {
      ...settings.ai,
      apiKey: '',
    },
    company: {
      ...settings.company,
      apiKey: '',
    },
  };
}

function blobRole(role: ArchiveExportBlob['role']): BlobMetadataRecord['role'] {
  return role === 'thumb' ? 'thumbnail' : role;
}

function streamJson(value: unknown): AsyncIterable<Uint8Array> {
  return (async function* jsonBytes(): AsyncIterable<Uint8Array> {
    yield encoder.encode(JSON.stringify(value));
  })();
}

function streamNdjson(rows: readonly unknown[]): AsyncIterable<Uint8Array> {
  return (async function* ndjsonBytes(): AsyncIterable<Uint8Array> {
    for (const row of rows) {
      yield encoder.encode(`${JSON.stringify(row)}\n`);
    }
  })();
}

function streamBlob(data: { stream: () => ReadableStream<Uint8Array> }): AsyncIterable<Uint8Array> {
  return (async function* blobBytes(): AsyncIterable<Uint8Array> {
    const reader = data.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

export async function writeArchiveExport(
  sink: ArchiveEntrySink,
  source: ArchiveExportDataSource,
): Promise<{ blobCount: number }> {
  const manifest = canonicalManifest();
  const settings = redactSettingsForArchive(source.getSettings());

  await sink.addEntry(manifest.settingsPath, streamJson(settings));

  for (const kind of ARCHIVE_ENTITY_KINDS) {
    const path = manifest.entityStreams[kind];
    if (!shouldExportEntityKind(kind)) {
      await sink.addEntry(path, streamNdjson([]));
      continue;
    }
    const rows = await source.listEntities(kind);
    await sink.addEntry(path, streamNdjson(rows));
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

  await sink.addEntry(manifest.blobMetadataPath, streamNdjson(metadata));

  for (const blob of blobs) {
    await sink.addEntry(canonicalBlobPath(blob.id), streamBlob(blob.data));
  }

  await sink.addEntry('manifest.json', streamJson(manifest));

  return { blobCount: blobs.length };
}
