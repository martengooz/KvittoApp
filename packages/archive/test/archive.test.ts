import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalBlobPath,
  canonicalManifest,
  canonicalEntityPath,
  preflightArchive,
  planImportMerge,
  type ArchiveEntry,
  type ArchiveEntrySource,
  type BlobMetadataRecord,
  type DigestImplementation,
  type SyncLikeEntity,
} from '../dist/index.js';

const encoder = new TextEncoder();

class MemoryArchiveSource implements ArchiveEntrySource {
  #entries: ArchiveEntry[];

  constructor(entries: Array<{ path: string; bytes: Uint8Array }>) {
    this.#entries = entries.map((entry) => ({
      path: entry.path,
      uncompressedSize: entry.bytes.byteLength,
      open: async function* open(): AsyncIterable<Uint8Array> {
        yield entry.bytes;
      },
    }));
  }

  async *entries(): AsyncIterable<ArchiveEntry> {
    for (const entry of this.#entries) {
      yield entry;
    }
  }
}

const digest: DigestImplementation = {
  async sha256Hex(chunks: AsyncIterable<Uint8Array>): Promise<string> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks) {
      parts.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    const input = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data.buffer
      : data.slice().buffer;
    const out = await crypto.subtle.digest('SHA-256', input);
    return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};

async function sha256HexFromBytes(bytes: Uint8Array): Promise<string> {
  return digest.sha256Hex(
    (async function* gen(): AsyncIterable<Uint8Array> {
      yield bytes;
    })(),
  );
}

function ndjson(records: unknown[]): Uint8Array {
  const text = records.map((r) => JSON.stringify(r)).join('\n');
  return encoder.encode(text.length > 0 ? `${text}\n` : '');
}

function emptyEntity(): SyncLikeEntity {
  return {
    id: 'id-1',
    updatedAt: 100,
    deletedAt: 0,
    rev: 9,
    dirty: 0,
  };
}

async function makeNormalArchive(): Promise<ArchiveEntrySource> {
  const manifest = canonicalManifest();
  const entity = emptyEntity();
  const blobBytes = encoder.encode('blob-content-1');
  const blobSha = await sha256HexFromBytes(blobBytes);

  const blobMeta: BlobMetadataRecord = {
    sha256: blobSha,
    mimeType: 'image/jpeg',
    width: 100,
    height: 50,
    sizeBytes: blobBytes.byteLength,
    role: 'processed',
  };

  const entries = [
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ sync: { autoSync: true }, ai: { mode: 'off' } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([blobMeta]) },
    ...Object.entries(manifest.entityStreams).map(([kind, p]) => ({
      path: p,
      bytes: ndjson(kind === 'secrets' ? [] : [entity]),
    })),
    { path: canonicalBlobPath(blobSha), bytes: blobBytes },
  ];

  return new MemoryArchiveSource(entries);
}

test('preflight: empty archive fails with missing manifest', async () => {
  const source = new MemoryArchiveSource([]);
  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'missing_manifest'));
});

test('preflight: normal archive passes', async () => {
  const source = await makeNormalArchive();
  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, true);
  assert.equal(report.issues.length, 0);
});

test('preflight: tombstone entity is accepted', async () => {
  const manifest = canonicalManifest();
  const tombstone: SyncLikeEntity = {
    id: 'dead-1',
    updatedAt: 123,
    deletedAt: 123,
    rev: 4,
    dirty: 0,
  };
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ sync: { autoSync: true } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([]) },
    ...Object.entries(manifest.entityStreams).map(([kind, p]) => ({
      path: p,
      bytes: ndjson(kind === 'receipts' ? [tombstone] : []),
    })),
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, true);
  assert.equal(report.entityCounts.receipts, 1);
});

test('preflight: malformed NDJSON fails', async () => {
  const manifest = canonicalManifest();
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ sync: { autoSync: true } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([]) },
    ...Object.entries(manifest.entityStreams).map(([kind, p]) => ({
      path: p,
      bytes: kind === 'receipts' ? encoder.encode('{ bad json\n') : ndjson([]),
    })),
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'malformed_ndjson'));
});

test('preflight: tampered blob fails integrity', async () => {
  const manifest = canonicalManifest();
  const sourceBlob = encoder.encode('original');
  const sha = await sha256HexFromBytes(sourceBlob);
  const tamperedBlob = encoder.encode('tampered');
  const blobMeta: BlobMetadataRecord = {
    sha256: sha,
    mimeType: 'image/jpeg',
    width: 1,
    height: 1,
    sizeBytes: tamperedBlob.byteLength,
    role: 'original',
  };

  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ sync: { autoSync: true } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([blobMeta]) },
    ...Object.entries(manifest.entityStreams).map(([_, p]) => ({ path: p, bytes: ndjson([]) })),
    { path: canonicalBlobPath(sha), bytes: tamperedBlob },
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'blob_sha_mismatch'));
});

test('preflight: traversal path is rejected', async () => {
  const manifest = canonicalManifest();
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: '../evil.ndjson', bytes: ndjson([]) },
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'invalid_path'));
});

test('preflight: duplicate path is rejected', async () => {
  const manifest = canonicalManifest();
  const bytes = encoder.encode(JSON.stringify(manifest));
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes },
    { path: 'manifest.json', bytes },
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'duplicate_path'));
});

test('preflight: future version is rejected', async () => {
  const manifest = canonicalManifest();
  const futureManifest = { ...manifest, version: 2 };
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(futureManifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ sync: { autoSync: true } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([]) },
    ...Object.entries(manifest.entityStreams).map(([_, p]) => ({ path: p, bytes: ndjson([]) })),
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'future_version'));
});

test('preflight: settings allowlist rejects secrets', async () => {
  const manifest = canonicalManifest();
  const source = new MemoryArchiveSource([
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ ai: { apiKey: 'secret' } })) },
    { path: manifest.blobMetadataPath, bytes: ndjson([]) },
    ...Object.entries(manifest.entityStreams).map(([_, p]) => ({ path: p, bytes: ndjson([]) })),
  ]);

  const report = await preflightArchive(source, { digest });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.code === 'settings_not_allowed'));
});

test('merge plan: imported winner preserves local rev and sets dirty', () => {
  const local: SyncLikeEntity = {
    id: 'r1',
    updatedAt: 5,
    deletedAt: 0,
    rev: 44,
    dirty: 0,
    total: 100,
  };

  const imported: SyncLikeEntity = {
    id: 'r1',
    updatedAt: 10,
    deletedAt: 0,
    rev: 9,
    dirty: 0,
    total: 120,
  };

  const plan = planImportMerge([imported], new Map([[local.id, local]]));
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]!.rev, 44);
  assert.equal(plan.updates[0]!.dirty, 1);
  assert.equal(plan.updates[0]!.total, 120);
});

test('merge plan: new entity resets rev and dirty while preserving tombstone/timestamps/id', () => {
  const imported: SyncLikeEntity = {
    id: 'r2',
    updatedAt: 50,
    deletedAt: 50,
    rev: 200,
    dirty: 0,
    note: 'x',
  };

  const plan = planImportMerge([imported], new Map());
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0]!.id, 'r2');
  assert.equal(plan.creates[0]!.updatedAt, 50);
  assert.equal(plan.creates[0]!.deletedAt, 50);
  assert.equal(plan.creates[0]!.rev, 0);
  assert.equal(plan.creates[0]!.dirty, 1);
});

test('merge plan: repeated import is idempotent', () => {
  const imported: SyncLikeEntity = {
    id: 'r3',
    updatedAt: 10,
    deletedAt: 0,
    rev: 9,
    dirty: 0,
    value: 7,
  };

  const localAfterFirst: SyncLikeEntity = {
    ...imported,
    rev: 91,
    dirty: 1,
  };

  const first = planImportMerge([imported], new Map([[localAfterFirst.id, { ...localAfterFirst, updatedAt: 1 }]]));
  assert.equal(first.updates.length, 1);

  const second = planImportMerge([imported], new Map([[localAfterFirst.id, first.updates[0]!]]));
  assert.equal(second.updates.length, 0);
  assert.deepEqual(second.noops, ['r3']);
});

test('preflight: canonical entity helper format', () => {
  assert.equal(canonicalEntityPath('receipts'), 'entities/receipts.ndjson');
});
