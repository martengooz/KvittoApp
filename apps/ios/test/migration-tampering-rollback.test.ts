import { describe, expect, test } from '@jest/globals';

import { canonicalManifest } from '@kvitto/archive';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { ArchivePreflightFailedError } from '../src/migration/preflight';
import { importArchiveWithStaging } from '../src/migration/importer';
import type { BlobStagingPort } from '../src/migration/types';
import { makeEntrySource } from './migration-fixtures';

const encoder = new TextEncoder();

class TrackingBlobStaging implements BlobStagingPort {
  began = 0;
  rolledBack = 0;

  async begin(): Promise<string> {
    this.began += 1;
    return 'staged';
  }

  async stageBlob(): Promise<void> {
    return undefined;
  }

  async commit(): Promise<void> {
    return undefined;
  }

  async rollback(): Promise<void> {
    this.rolledBack += 1;
  }
}

function tamperedArchiveWithTraversal() {
  const manifest = canonicalManifest();
  const files = [
    { path: manifest.settingsPath, bytes: encoder.encode(JSON.stringify({ scan: { autoCapture: true } })) },
    ...Object.values(manifest.entityStreams).map((path) => ({ path, bytes: encoder.encode('') })),
    { path: manifest.blobMetadataPath, bytes: encoder.encode('{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","mimeType":"image/jpeg","width":1,"height":1,"sizeBytes":3,"role":"processed"}\n') },
    { path: 'blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', bytes: new Uint8Array([1, 2, 3]) },
    { path: '../escape.txt', bytes: encoder.encode('tamper') },
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest)) },
  ];
  return files;
}

describe('migration tampering and rollback', () => {
  test('fails preflight on traversal path and leaves no staged side effects', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());
    const staging = new TrackingBlobStaging();

    await expect(
      importArchiveWithStaging({
        sourceFactory: {
          create: async () => makeEntrySource(tamperedArchiveWithTraversal()),
        },
        repository: repo,
        blobStaging: staging,
      }),
    ).rejects.toBeInstanceOf(ArchivePreflightFailedError);

    expect(staging.began).toBe(0);
    expect(staging.rolledBack).toBe(0);
    const counts = await repo.countByKind();
    expect(counts.receipts).toBe(0);
    expect(counts.items).toBe(0);
  });
});
