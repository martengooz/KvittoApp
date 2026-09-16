import { canonicalManifest, type ArchiveEntry, type ArchiveEntrySource, type ArchiveEntityKind } from '@kvitto/archive';
import { createHash } from 'node:crypto';

const encoder = new TextEncoder();

type ArchiveFile = {
  path: string;
  bytes: Uint8Array;
};

function asEntry(file: ArchiveFile): ArchiveEntry {
  return {
    path: file.path,
    uncompressedSize: file.bytes.byteLength,
    open: async function* open() {
      yield file.bytes;
    },
  };
}

export function makeEntrySource(files: ArchiveFile[]): ArchiveEntrySource {
  const frozen = files.map((file) => ({ path: file.path, bytes: file.bytes.slice(0) }));
  return {
    entries: async function* entries() {
      for (const file of frozen) {
        yield asEntry(file);
      }
    },
  };
}

function ndjson(rows: readonly unknown[]): Uint8Array {
  return encoder.encode(rows.map((row) => JSON.stringify(row)).join('\n'));
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function makeSha(seed = 'a'): string {
  const chunk = seed.repeat(64);
  return chunk.slice(0, 64).replace(/[^a-f0-9]/g, 'a');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface FixtureInput {
  entities?: Partial<Record<ArchiveEntityKind, Record<string, unknown>[]>>;
  settings?: Record<string, unknown>;
  blobs?: Array<{ sha256?: string; mimeType?: string; bytes: Uint8Array; role?: 'original' | 'processed' | 'thumbnail' }>;
}

export function makeArchiveFixture(input: FixtureInput = {}): ArchiveFile[] {
  const manifest = canonicalManifest();
  const files: ArchiveFile[] = [];

  const settings = input.settings ?? {
    scan: { autoCapture: true, jpegQuality: 0.9, colorMode: 'grayscale' },
    ocr: { languages: ['sv-SE'], languageCorrection: true },
    sync: { autoSync: true, wifiOnly: false },
    ui: { locale: 'sv-SE', currency: 'SEK', compactList: false },
    ai: { mode: 'none', provider: 'none' },
  };

  files.push({ path: manifest.settingsPath, bytes: json(settings) });

  for (const kind of Object.keys(manifest.entityStreams) as ArchiveEntityKind[]) {
    const rows = input.entities?.[kind] ?? [];
    files.push({ path: manifest.entityStreams[kind], bytes: ndjson(rows) });
  }

  const blobs = input.blobs ?? [];
  const normalized = blobs.map((blob) => ({
    ...blob,
    sha256: blob.sha256 ?? sha256Hex(blob.bytes),
  }));

  const metadata = normalized.map((blob) => ({
    sha256: blob.sha256,
    mimeType: blob.mimeType ?? 'image/jpeg',
    width: 120,
    height: 80,
    sizeBytes: blob.bytes.byteLength,
    role: blob.role ?? 'processed',
  }));

  files.push({ path: manifest.blobMetadataPath, bytes: ndjson(metadata) });

  for (const blob of normalized) {
    files.push({ path: `blobs/${blob.sha256}`, bytes: blob.bytes });
  }

  files.push({ path: 'manifest.json', bytes: json(manifest) });
  return files;
}
