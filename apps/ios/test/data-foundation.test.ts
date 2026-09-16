import { describe, expect, test } from '@jest/globals';
import type { Receipt } from '@kvitto/shared/domain';

import { InMemoryDatabaseKeyStore } from '../src/data/keychain';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { startDataFoundation } from '../src/data/startup';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  const base: Receipt = {
    id: 'receipt-base',
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1,
    merchant: {
      name: null,
      orgNumber: null,
      vatNumber: null,
      address: null,
      postalCode: null,
      city: null,
      country: null,
      phone: null,
      storeId: null,
    },
    purchasedAt: '2026-01-10T11:30:00.000Z',
    currency: 'SEK',
    total: 129.5,
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
  };
  return {
    ...base,
    merchant: { ...base.merchant, name: 'ICA Maxi' },
    ...overrides,
  };
}

describe('Packet 3 data foundation', () => {
  test('startup sequence applies key, WAL, FK, migrations, FTS, categories and job restore', async () => {
    const db = new SqliteTestAdapter();
    const keyStore = new InMemoryDatabaseKeyStore();
    const repo = new IosDataRepository(db, () => 1000);

    let restored = 0;
    const result = await startDataFoundation({
      db,
      keyStore,
      repository: repo,
      hooks: {
        restoreInterruptedJobs: async () => {
          restored += 1;
        },
      },
    });

    expect(result.steps).toEqual([
      'keychain-key-ready',
      'sqlcipher-key-applied',
      'wal-enabled',
      'foreign-keys-enabled',
      'migrations-applied',
      'fts-ready',
      'default-categories-seeded',
      'durable-jobs-restored',
    ]);
    expect(result.migrationIds.length).toBeGreaterThan(0);
    expect(restored).toBe(1);
    expect(db.getDiagnostics().keyed).toBe(true);
    expect(db.getDiagnostics().journalMode).toBe('wal');
    expect(db.getDiagnostics().foreignKeysEnabled).toBe(true);
  });

  test('migration application is idempotent', async () => {
    const db = new SqliteTestAdapter();
    const keyStore = new InMemoryDatabaseKeyStore();
    const repo = new IosDataRepository(db, () => 1000);

    const first = await startDataFoundation({ db, keyStore, repository: repo });
    const second = await startDataFoundation({ db, keyStore, repository: repo });

    expect(first.migrationIds.length).toBeGreaterThan(0);
    expect(second.migrationIds).toEqual([]);
  });

  test('CRUD mutations enforce dirty and updatedAt invariants and support mark-clean guard', async () => {
    let now = 2000;
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => now);

    const receipt = await repo.createReceipt({ id: 'r1' });
    expect(receipt.dirty).toBe(1);
    expect(receipt.updatedAt).toBe(2000);

    now = 2500;
    const changed = await repo.updateReceipt('r1', { total: 220 });
    expect(changed?.dirty).toBe(1);
    expect(changed?.updatedAt).toBe(2500);

    const dirty = await repo.listDirty(10);
    expect(dirty).toHaveLength(1);

    now = 3000;
    await repo.updateReceipt('r1', { notes: 'manual correction' });
    const cleaned = await repo.markCleanIfUpdatedAtMatches(dirty[0]!, 9);
    expect(cleaned).toBe(false);

    const fresh = await repo.listDirty(10);
    const cleanedFresh = await repo.markCleanIfUpdatedAtMatches(fresh[0]!, 11);
    expect(cleanedFresh).toBe(true);

    const current = await repo.get('receipts', 'r1');
    expect(current?.dirty).toBe(0);
    expect(current?.rev).toBe(11);
  });

  test('receipt and item queries support FTS and keyset pagination', async () => {
    let now = 5000;
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => now);

    await repo.upsert('receipts', makeReceipt({ id: 'r1', purchasedAt: '2026-02-10T10:00:00.000Z' }));
    await repo.upsert('receipts', makeReceipt({ id: 'r2', purchasedAt: '2026-02-08T10:00:00.000Z', merchant: { ...makeReceipt().merchant, name: 'Willys' } }));
    await repo.upsert('receipts', makeReceipt({ id: 'r3', purchasedAt: null, merchant: { ...makeReceipt().merchant, name: 'Lidl' } }));

    now = 5200;
    await repo.addItem('r2', { id: 'i1', name: 'Havremjolk', totalPrice: 24.9 });

    const ftsByItem = await repo.queryReceipts({ query: 'havremjolk' }, 10);
    expect(ftsByItem.items.map((row) => row.id)).toEqual(['r2']);

    const page1 = await repo.queryReceipts({}, 2);
    expect(page1.items.map((row) => row.id)).toEqual(['r1', 'r2']);
    expect(page1.hasMore).toBe(true);

    const page2 = await repo.queryReceipts({}, 2, page1.nextCursor ?? undefined);
    expect(page2.items.map((row) => row.id)).toEqual(['r3']);
    expect(page2.hasMore).toBe(false);
  });

  test('aggregate hooks update summary, and tombstone/undo cascades with shared timestamp', async () => {
    let now = 7000;
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => now);

    await repo.upsert('receipts', makeReceipt({ id: 'r10', purchasedAt: '2026-03-01T10:00:00.000Z', total: 90 }));
    await repo.upsert('receipts', makeReceipt({ id: 'r11', purchasedAt: '2026-03-02T10:00:00.000Z', total: 110 }));
    await repo.addItem('r10', { id: 'i10', name: 'Mjolk', searchName: 'mjolk', totalPrice: 30 });
    await repo.addItem('r10', { id: 'i11', name: 'Rabattkupong', searchName: 'rabattkupong', totalPrice: -5, isDiscount: true });
    await repo.addItem('r11', { id: 'i12', name: 'Brod', searchName: 'brod', totalPrice: 25 });

    const beforeDelete = await repo.getSpendSummary();
    expect(beforeDelete.receiptCount).toBe(2);
    expect(beforeDelete.total).toBe(200);
    expect(beforeDelete.byMonth[0]?.month).toBe('2026-03');

    now = 9000;
    await repo.deleteReceipt('r10');

    const deletedReceipt = await repo.get('receipts', 'r10');
    const deletedItem = await repo.get('items', 'i10');
    expect(deletedReceipt?.deletedAt).toBe(9000);
    expect(deletedItem?.deletedAt).toBe(9000);

    await repo.restoreReceipt('r10');
    const restoredReceipt = await repo.get('receipts', 'r10');
    const restoredItem = await repo.get('items', 'i10');
    expect(restoredReceipt?.deletedAt).toBe(0);
    expect(restoredItem?.deletedAt).toBe(0);

    const afterRestore = await repo.getSpendSummary();
    expect(afterRestore.receiptCount).toBe(2);
    expect(afterRestore.byCategory.reduce((sum, row) => sum + row.count, 0)).toBe(2);
  });

  test('subscriptions fire and transactions roll back on error', async () => {
    let now = 11_000;
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => now);

    const events: string[] = [];
    const unsubscribe = repo.subscribe((event) => {
      events.push(event.reason);
    });

    await repo.createReceipt({ id: 'rollback-r' });
    const before = await repo.countByKind();

    await expect(
      repo.runInTransaction(async () => {
        await repo.addItem('rollback-r', { id: 'rb-item', name: 'Apelsin', totalPrice: 15 });
        now = 12_000;
        await repo.updateReceipt('rollback-r', { notes: 'should rollback' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await repo.countByKind();
    expect(after.items).toBe(before.items);

    const receipt = await repo.get('receipts', 'rollback-r');
    expect(receipt?.notes).toBeNull();

    unsubscribe();
    expect(events.length).toBeGreaterThan(0);
  });
});
