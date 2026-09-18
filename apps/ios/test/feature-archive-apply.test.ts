/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';
import type { ArchiveEntrySource } from '@kvitto/archive';

import { applyArchive, type ApplyNativePort } from '../src/archive/apply';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function makeRepository(now = 1000) {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => now) };
}

/** An archive as a map of path to text, plus blob bytes keyed by digest. */
function makeSource(entries: Record<string, string>): ArchiveEntrySource {
  return {
    entries: async function* () {
      for (const [path, content] of Object.entries(entries)) {
        yield {
          path,
          uncompressedSize: content.length,
          open: async function* () {
            yield new TextEncoder().encode(content);
          },
        };
      }
    },
  };
}

function fakeNative(options: {
  /** digest -> what hashFileSha256 will report for that blob's staged file. */
  digests?: Record<string, string>;
  failStoreOn?: string;
} = {}) {
  const staged = new Map<string, string>();
  const deleted: string[] = [];
  const stored: string[] = [];
  let count = 0;

  const port: ApplyNativePort = {
    makeScratchFileUri: () => `file:///staging/${(count += 1)}.bin`,
    extractArchiveEntry: async (_archive, path, destination) => {
      staged.set(destination, path);
      return 1;
    },
    hashFileSha256: async (uri) => {
      const path = staged.get(uri) ?? '';
      const declared = path.slice('blobs/'.length);
      return options.digests?.[declared] ?? declared;
    },
    storeContentAddressedFile: async (request) => {
      const path = staged.get(request.sourceUri) ?? '';
      const sha = path.slice('blobs/'.length);
      if (options.failStoreOn === sha) throw new Error('blob store is full');
      stored.push(sha);
      return { sha256Id: sha, uri: `file:///blobs/${sha}` } as never;
    },
    deleteScratchFile: async (uri) => {
      deleted.push(uri);
      return true;
    },
  };

  return { port, deleted, stored };
}

function receiptRow(overrides: Partial<Receipt> = {}): Record<string, unknown> {
  return {
    id: 'r-1',
    updatedAt: 5000,
    deletedAt: 0,
    rev: 7,
    dirty: 0,
    merchant: { ...emptyMerchant(), name: 'ICA Maxi' },
    purchasedAt: '2026-02-10T12:00:00.000Z',
    currency: 'SEK',
    total: 120,
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
    imageId: null,
    originalImageId: null,
    thumbId: null,
    status: 'parsed',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  };
}

const SHA_A = 'a'.repeat(64);

function blobMetadata(sha256: string): string {
  return JSON.stringify({
    sha256,
    mimeType: 'image/jpeg',
    width: 10,
    height: 20,
    sizeBytes: 100,
    role: 'processed',
  });
}

describe('applying entities', () => {
  test('a new entity is created with its id and timestamps preserved, rev reset, dirty set', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    const result = await applyArchive(
      repository,
      port,
      makeSource({ 'entities/receipts.ndjson': JSON.stringify(receiptRow()) }),
      'file:///a.kvitto',
    );

    expect(result.created).toBe(1);
    const stored = await repository.getReceipt('r-1');
    expect(stored?.updatedAt).toBe(5000);
    // Section 14: preserve id and timestamps, set dirty = 1, reset rev = 0.
    expect(stored?.rev).toBe(0);
    expect(stored?.dirty).toBe(1);
    db.close();
  });

  test('a tombstone is imported as a tombstone, not dropped', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    await applyArchive(
      repository,
      port,
      makeSource({ 'entities/receipts.ndjson': JSON.stringify(receiptRow({ deletedAt: 4000 } as never)) }),
      'file:///a.kvitto',
    );

    expect((await repository.get('receipts', 'r-1'))?.deletedAt).toBe(4000);
    db.close();
  });

  test('a newer imported row wins and keeps the local server revision', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();
    await repository.upsert('receipts', { ...receiptRow({ total: 50 } as never), rev: 9, dirty: 0 } as never);

    await applyArchive(
      repository,
      port,
      makeSource({
        'entities/receipts.ndjson': JSON.stringify(receiptRow({ total: 999, updatedAt: 9000 } as never)),
      }),
      'file:///a.kvitto',
    );

    const stored = await repository.getReceipt('r-1');
    expect(stored?.total).toBe(999);
    // The local rev is what the next push needs, so it survives the import.
    expect(stored?.rev).toBe(9);
    expect(stored?.dirty).toBe(1);
    db.close();
  });

  test('an older imported row loses and the local row is left alone', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();
    await repository.upsert('receipts', receiptRow({ total: 50, updatedAt: 9000 } as never) as never);

    const result = await applyArchive(
      repository,
      port,
      makeSource({
        'entities/receipts.ndjson': JSON.stringify(receiptRow({ total: 999, updatedAt: 1000 } as never)),
      }),
      'file:///a.kvitto',
    );

    expect(result.unchanged).toBe(1);
    expect((await repository.getReceipt('r-1'))?.total).toBe(50);
    db.close();
  });

  test('re-importing the same archive changes nothing', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();
    const source = () => makeSource({ 'entities/receipts.ndjson': JSON.stringify(receiptRow()) });

    const first = await applyArchive(repository, port, source(), 'file:///a.kvitto');
    const second = await applyArchive(repository, port, source(), 'file:///a.kvitto');

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    db.close();
  });

  test('malformed NDJSON aborts before anything is written', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    await expect(
      applyArchive(
        repository,
        port,
        makeSource({ 'entities/receipts.ndjson': '{"id":"r-1"' }),
        'file:///a.kvitto',
      ),
    ).rejects.toThrow('not valid JSON');

    expect((await repository.queryReceipts({}, 10)).items).toEqual([]);
    db.close();
  });

  test('a row without sync fields is refused rather than written', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    await expect(
      applyArchive(
        repository,
        port,
        makeSource({ 'entities/receipts.ndjson': JSON.stringify({ id: 'r-1', total: 5 }) }),
        'file:///a.kvitto',
      ),
    ).rejects.toThrow('valid sync fields');

    expect((await repository.queryReceipts({}, 10)).items).toEqual([]);
    db.close();
  });
});

describe('blob staging', () => {
  test('a blob is verified in staging and only then promoted', async () => {
    const { db, repository } = makeRepository();
    const { port, stored, deleted } = fakeNative();

    const result = await applyArchive(
      repository,
      port,
      makeSource({
        'entities/receipts.ndjson': JSON.stringify(receiptRow()),
        'blob-metadata.ndjson': blobMetadata(SHA_A),
        [`blobs/${SHA_A}`]: 'image-bytes',
      }),
      'file:///a.kvitto',
    );

    expect(result.blobsStored).toBe(1);
    expect(stored).toEqual([SHA_A]);
    // Staging files never survive the import.
    expect(deleted.length).toBeGreaterThan(0);
    db.close();
  });

  test('a blob whose digest does not match is refused, and no entity is written', async () => {
    const { db, repository } = makeRepository();
    const { port, stored } = fakeNative({ digests: { [SHA_A]: 'b'.repeat(64) } });

    await expect(
      applyArchive(
        repository,
        port,
        makeSource({
          'entities/receipts.ndjson': JSON.stringify(receiptRow()),
          'blob-metadata.ndjson': blobMetadata(SHA_A),
          [`blobs/${SHA_A}`]: 'tampered',
        }),
        'file:///a.kvitto',
      ),
    ).rejects.toThrow('does not match its digest');

    // Verification happens before the transaction, so nothing landed.
    expect(stored).toEqual([]);
    expect((await repository.queryReceipts({}, 10)).items).toEqual([]);
    db.close();
  });

  test('a blob with no metadata line is refused', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    await expect(
      applyArchive(
        repository,
        port,
        makeSource({ 'blob-metadata.ndjson': '', [`blobs/${SHA_A}`]: 'orphan' }),
        'file:///a.kvitto',
      ),
    ).rejects.toThrow('has no entry in blob-metadata.ndjson');
    db.close();
  });

  test('staging files are removed even when promotion fails', async () => {
    const { db, repository } = makeRepository();
    const { port, deleted } = fakeNative({ failStoreOn: SHA_A });

    await expect(
      applyArchive(
        repository,
        port,
        makeSource({
          'blob-metadata.ndjson': blobMetadata(SHA_A),
          [`blobs/${SHA_A}`]: 'bytes',
        }),
        'file:///a.kvitto',
      ),
    ).rejects.toThrow('blob store is full');

    expect(deleted.length).toBeGreaterThan(0);
    db.close();
  });

  test('an archive with no blobs applies its entities fine', async () => {
    const { db, repository } = makeRepository();
    const { port, stored } = fakeNative();

    const result = await applyArchive(
      repository,
      port,
      makeSource({ 'entities/receipts.ndjson': JSON.stringify(receiptRow()) }),
      'file:///a.kvitto',
    );

    expect(result.blobsStored).toBe(0);
    expect(stored).toEqual([]);
    expect(result.created).toBe(1);
    db.close();
  });
});

describe('transactional guarantee', () => {
  test('subscribers are notified once, after the commit, not per row', async () => {
    const { db, repository } = makeRepository();
    const { port } = fakeNative();

    const rows = Array.from({ length: 25 }, (_, index) =>
      JSON.stringify(receiptRow({ id: `r-${index}` } as never)),
    ).join('\n');

    const events: string[] = [];
    const unsubscribe = repository.subscribe((event) => events.push(event.reason));
    await applyArchive(
      repository,
      port,
      makeSource({ 'entities/receipts.ndjson': rows }),
      'file:///a.kvitto',
    );
    unsubscribe();

    expect(events).toEqual(['incoming']);
    expect((await repository.queryReceipts({}, 50)).items).toHaveLength(25);
    db.close();
  });
});
