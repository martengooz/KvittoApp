import { describe, expect, test } from '@jest/globals';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { importArchiveWithStaging } from '../src/migration/importer';
import type { BlobStagingPort } from '../src/migration/types';
import { makeArchiveFixture, makeEntrySource, sha256Hex } from './migration-fixtures';

class NoopBlobStaging implements BlobStagingPort {
  async begin(): Promise<string> {
    return 's1';
  }

  async stageBlob(): Promise<void> {
    return undefined;
  }

  async commit(): Promise<void> {
    return undefined;
  }

  async rollback(): Promise<void> {
    return undefined;
  }
}

function buildFixture(updatedAt: number, total: number) {
  const blobBytes = new Uint8Array([9, 9]);
  const blobSha = sha256Hex(blobBytes);
  const files = makeArchiveFixture({
    entities: {
      receipts: [
        {
          id: 'r-repeat',
          updatedAt,
          deletedAt: 0,
          rev: 0,
          dirty: 1,
          merchant: {
            name: 'Coop',
            orgNumber: null,
            vatNumber: null,
            address: null,
            postalCode: null,
            city: null,
            country: null,
            phone: null,
            storeId: null,
          },
          purchasedAt: '2026-09-16T11:00:00.000Z',
          currency: 'SEK',
          total,
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
    blobs: [{ sha256: blobSha, bytes: blobBytes }],
  });
  return files;
}

describe('migration repeated imports and conflicts', () => {
  test('converges on idempotent no-op for repeated archive import', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());

    const fixture = buildFixture(100, 55);
    const first = await importArchiveWithStaging({
      sourceFactory: { create: async () => makeEntrySource(fixture) },
      repository: repo,
      blobStaging: new NoopBlobStaging(),
    });
    const second = await importArchiveWithStaging({
      sourceFactory: { create: async () => makeEntrySource(fixture) },
      repository: repo,
      blobStaging: new NoopBlobStaging(),
    });

    expect(first.merged.creates).toBeGreaterThan(0);
    expect(second.merged.noops).toBeGreaterThan(0);
  });

  test('keeps newer local record when import is stale', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => 500);

    const fixture = buildFixture(100, 20);
    await importArchiveWithStaging({
      sourceFactory: { create: async () => makeEntrySource(fixture) },
      repository: repo,
      blobStaging: new NoopBlobStaging(),
    });

    await repo.updateReceipt('r-repeat', { total: 200 });

    const staleImport = buildFixture(90, 10);
    const result = await importArchiveWithStaging({
      sourceFactory: { create: async () => makeEntrySource(staleImport) },
      repository: repo,
      blobStaging: new NoopBlobStaging(),
    });

    const local = await repo.getReceipt('r-repeat');
    expect(local?.total).toBe(200);
    expect(result.merged.noops).toBeGreaterThan(0);
  });
});
