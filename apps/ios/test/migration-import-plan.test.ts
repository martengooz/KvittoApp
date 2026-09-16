import { describe, expect, test } from '@jest/globals';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { importArchiveWithStaging } from '../src/migration/importer';
import type { BlobStagingPort } from '../src/migration/types';
import { makeArchiveFixture, makeEntrySource, sha256Hex } from './migration-fixtures';

class InMemoryBlobStaging implements BlobStagingPort {
  readonly staged = new Map<string, Uint8Array>();
  readonly live = new Map<string, Uint8Array>();
  began = 0;
  committed = 0;
  rolledBack = 0;

  async begin(): Promise<string> {
    this.began += 1;
    return `staging-${this.began}`;
  }

  async stageBlob(_stagingId: string, sha256: string, bytes: AsyncIterable<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of bytes) chunks.push(chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.staged.set(sha256, out);
  }

  async commit(_stagingId: string): Promise<void> {
    for (const [sha, bytes] of this.staged) {
      this.live.set(sha, bytes);
    }
    this.staged.clear();
    this.committed += 1;
  }

  async rollback(_stagingId: string): Promise<void> {
    this.staged.clear();
    this.rolledBack += 1;
  }
}

describe('migration-import plan', () => {
  test('imports preflighted archive using staging and transactional merge', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1234);
    const blobStaging = new InMemoryBlobStaging();

    const blobBytes = new Uint8Array([1, 2, 3, 4]);
    const blobSha = sha256Hex(blobBytes);
    const fixture = makeArchiveFixture({
      entities: {
        receipts: [
          {
            id: 'r-import-1',
            updatedAt: 100,
            deletedAt: 0,
            rev: 0,
            dirty: 1,
            merchant: {
              name: 'ICA Maxi',
              orgNumber: null,
              vatNumber: null,
              address: null,
              postalCode: null,
              city: null,
              country: null,
              phone: null,
              storeId: null,
            },
            purchasedAt: '2026-09-16T10:00:00.000Z',
            currency: 'SEK',
            total: 99,
            subtotal: null,
            discountTotal: null,
            roundingAmount: null,
            depositTotal: null,
            vatLines: [],
            paymentMethod: null,
            cardLast4: null,
            receiptNumber: null,
            terminalId: null,
            cashier: null,
            categoryId: null,
            companyId: null,
            notes: null,
            source: 'manual',
            imageId: blobSha,
            originalImageId: null,
            thumbId: null,
            status: 'confirmed',
            extraction: null,
            ocr: null,
            itemCount: 0,
          },
        ],
      },
      blobs: [
        {
          sha256: blobSha,
          bytes: blobBytes,
        },
      ],
    });

    const result = await importArchiveWithStaging({
      sourceFactory: {
        create: async () => makeEntrySource(fixture),
      },
      repository,
      blobStaging,
      settings: {
        applyImportedSettings: async () => undefined,
      },
    });

    expect(result.preflight.ok).toBe(true);
    expect(result.merged.creates).toBeGreaterThanOrEqual(1);
    expect(result.blob.staged).toBe(1);
    expect(blobStaging.live.has(blobSha)).toBe(true);
    expect(await repository.get('receipts', 'r-import-1')).not.toBeNull();
  });
});
