import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Receipt } from '@kvitto/shared/domain';

import { InMemoryDatabaseKeyStore } from '../src/data/keychain';
import { IosDataRepository, type ReceiptListCursor } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { startDataFoundation } from '../src/data/startup';

const scratchDirs: string[] = [];

function scratchDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kvitto-ios-sql-'));
  scratchDirs.push(dir);
  return join(dir, 'kvitto-ios.db');
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  const base: Receipt = {
    id: 'receipt-base',
    updatedAt: 1000,
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
    purchasedAt: '2026-01-10T11:30:00.000Z',
    currency: 'SEK',
    total: 100,
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
  return { ...base, ...overrides };
}

/** Models an app relaunch: a fresh adapter and repository over the same file. */
async function relaunch(path: string, now = () => 1_000) {
  const db = new SqliteTestAdapter(path);
  const repository = new IosDataRepository(db, now);
  const startup = await startDataFoundation({
    db,
    keyStore: new InMemoryDatabaseKeyStore(),
    repository,
  });
  return { db, repository, startup };
}

describe('direct SQL repository persistence', () => {
  test('entities, key-value state and sync cursor survive a relaunch', async () => {
    const path = scratchDatabasePath();

    const first = await relaunch(path);
    await first.repository.upsert('receipts', makeReceipt({ id: 'r1', notes: 'kvartalsrapport' }));
    await first.repository.addItem('r1', { id: 'i1', name: 'Havremjolk', totalPrice: 24.9 });
    await first.repository.setKeyValue('device:name', 'Martens iPhone');
    await first.repository.setSyncState({ cursor: 42, epoch: 'epoch-7' });
    first.db.close();

    const second = await relaunch(path);
    expect(second.startup.migrationIds).toEqual([]);

    const receipt = await second.repository.getReceipt('r1');
    expect(receipt?.notes).toBe('kvartalsrapport');
    expect(receipt?.itemCount).toBe(1);
    expect(await second.repository.getKeyValue('device:name')).toBe('Martens iPhone');
    expect(await second.repository.getSyncState()).toEqual({ cursor: 42, epoch: 'epoch-7' });

    const counts = await second.repository.countByKind();
    expect(counts.receipts).toBe(1);
    expect(counts.items).toBe(1);
    second.db.close();
  });

  test('full-text search still resolves after a relaunch rebuilds the index', async () => {
    const path = scratchDatabasePath();

    const first = await relaunch(path);
    await first.repository.upsert('receipts', makeReceipt({ id: 'r1' }));
    await first.repository.addItem('r1', { id: 'i1', name: 'Havremjolk', totalPrice: 24.9 });
    first.db.close();

    const second = await relaunch(path);
    const byMerchant = await second.repository.queryReceipts({ query: 'ica' }, 10);
    expect(byMerchant.items.map((row) => row.id)).toEqual(['r1']);

    const byItem = await second.repository.queryReceipts({ query: 'havremjolk' }, 10);
    expect(byItem.items.map((row) => row.id)).toEqual(['r1']);

    const noMatch = await second.repository.queryReceipts({ query: 'willys' }, 10);
    expect(noMatch.items).toEqual([]);
    second.db.close();
  });

  test('receipt status words are not searchable, but notes and receipt numbers are', async () => {
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => 1000);

    await repo.upsert(
      'receipts',
      makeReceipt({ id: 'r1', status: 'parsed', notes: 'Tjansteresa Goteborg', receiptNumber: 'KV-9912' }),
    );

    expect((await repo.queryReceipts({ query: 'parsed' }, 10)).items).toEqual([]);
    expect((await repo.queryReceipts({ query: 'tjansteresa' }, 10)).items.map((r) => r.id)).toEqual(['r1']);
    expect((await repo.queryReceipts({ query: 'kv 9912' }, 10)).items.map((r) => r.id)).toEqual(['r1']);
    db.close();
  });

  test('a failed transaction rolls the database back, not just an in-memory mirror', async () => {
    const path = scratchDatabasePath();
    const first = await relaunch(path);

    await first.repository.createReceipt({ id: 'r1' });

    await expect(
      first.repository.runInTransaction(async () => {
        await first.repository.addItem('r1', { id: 'i1', name: 'Apelsin', totalPrice: 15 });
        await first.repository.updateReceipt('r1', { notes: 'should roll back' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    first.db.close();

    const second = await relaunch(path);
    expect((await second.repository.countByKind()).items).toBe(0);
    expect((await second.repository.getReceipt('r1'))?.notes).toBeNull();
    expect((await second.repository.queryPurchases({}, 10)).items).toEqual([]);
    second.db.close();
  });

  test('keyset pagination walks every receipt exactly once across ties and null dates', async () => {
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => 1000);

    for (const id of ['a', 'b', 'c']) {
      await repo.upsert('receipts', makeReceipt({ id, purchasedAt: '2026-02-08T10:00:00.000Z' }));
    }
    await repo.upsert('receipts', makeReceipt({ id: 'd', purchasedAt: '2026-03-01T10:00:00.000Z' }));
    await repo.upsert('receipts', makeReceipt({ id: 'e', purchasedAt: null }));

    const seen: string[] = [];
    let cursor: ReceiptListCursor | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await repo.queryReceipts({}, 2, cursor ?? undefined);
      seen.push(...result.items.map((row) => row.id));
      cursor = result.nextCursor;
      if (!result.hasMore) break;
    }

    expect(seen).toEqual(['d', 'a', 'b', 'c', 'e']);
    db.close();
  });

  test('purchase queries filter on projected discount, deposit, price and date columns', async () => {
    const db = new SqliteTestAdapter();
    let now = 1000;
    const repo = new IosDataRepository(db, () => now);

    await repo.upsert('receipts', makeReceipt({ id: 'r1', currency: 'SEK', purchasedAt: '2026-02-08T10:00:00.000Z' }));
    now = 1100;
    await repo.addItem('r1', { id: 'i1', name: 'Mjolk', totalPrice: 30 });
    now = 1200;
    await repo.addItem('r1', { id: 'i2', name: 'Rabatt', totalPrice: -5, isDiscount: true });
    now = 1300;
    await repo.addItem('r1', { id: 'i3', name: 'Pant', totalPrice: 2, isDeposit: true });

    const plain = await repo.queryPurchases({}, 10);
    expect(plain.items.map((row) => row.item.id)).toEqual(['i1']);
    expect(plain.items[0]?.merchantName).toBe('ICA Maxi');
    expect(plain.items[0]?.currency).toBe('SEK');
    expect(plain.items[0]?.purchasedAt).toBe('2026-02-08T10:00:00.000Z');

    const withExtras = await repo.queryPurchases({ includeDiscounts: true, includeDeposits: true }, 10);
    expect(withExtras.items.map((row) => row.item.id)).toEqual(['i3', 'i2', 'i1']);

    expect((await repo.queryPurchases({ minPrice: 10 }, 10)).items.map((r) => r.item.id)).toEqual(['i1']);
    expect((await repo.queryPurchases({ from: '2026-03-01' }, 10)).items).toEqual([]);
    expect((await repo.queryPurchases({ query: 'mjol' }, 10)).items.map((r) => r.item.id)).toEqual(['i1']);

    const summary = await repo.getSpendSummary();
    expect(summary.itemCount).toBe(3);
    expect(summary.byCategory.reduce((sum, row) => sum + row.count, 0)).toBe(1);
    db.close();
  });

  test('needsReview is projected at write time and filters in SQL', async () => {
    const db = new SqliteTestAdapter();
    const repo = new IosDataRepository(db, () => 1000);

    await repo.upsert('receipts', makeReceipt({ id: 'ok', status: 'confirmed' }));
    await repo.upsert('receipts', makeReceipt({ id: 'bad', status: 'failed' }));

    const flagged = await repo.queryReceipts({ needsReview: true }, 10);
    expect(flagged.items.map((row) => row.id)).toEqual(['bad']);

    await repo.updateReceipt('bad', { status: 'confirmed' });
    expect((await repo.queryReceipts({ needsReview: true }, 10)).items).toEqual([]);
    db.close();
  });
});
