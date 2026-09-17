/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Receipt, type ReceiptItem } from '@kvitto/shared/domain';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function makeRepository(): { db: SqliteTestAdapter; repository: IosDataRepository } {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => 1000) };
}

async function seedReceipt(
  repository: IosDataRepository,
  overrides: Partial<Receipt> = {},
): Promise<void> {
  await repository.upsert('receipts', {
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1 as const,
    id: 'r-1',
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
  });
}

async function seedItem(
  repository: IosDataRepository,
  overrides: Partial<ReceiptItem> = {},
): Promise<void> {
  await repository.upsert('items', {
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1 as const,
    id: 'i-1',
    receiptId: 'r-1',
    lineNo: 0,
    rawName: 'Mjölk',
    name: 'Mjölk',
    searchName: 'mjolk',
    quantity: 1,
    unit: null,
    unitPrice: 15,
    totalPrice: 15,
    vatRate: null,
    categoryId: null,
    isDiscount: false,
    isDeposit: false,
    notes: null,
    ...overrides,
  } as ReceiptItem);
}

describe('category CRUD', () => {
  test('creating assigns a colour and a sort order after the existing rows', async () => {
    const { db, repository } = makeRepository();

    const first = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    const second = await repository.saveCategory({ name: 'Resa', color: '#22a06b' });

    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
    expect((await repository.listCategories()).map((row) => row.name)).toEqual(['Mat', 'Resa']);
    db.close();
  });

  test('saving with an id renames in place rather than creating a second row', async () => {
    const { db, repository } = makeRepository();
    const created = await repository.saveCategory({ name: 'Mat', color: '#4f7cff', icon: '🛒' });

    const renamed = await repository.saveCategory({ id: created.id, name: 'Livsmedel', color: '#22a06b' });

    expect(renamed.id).toBe(created.id);
    expect(renamed.sortOrder).toBe(created.sortOrder);
    // An omitted icon is kept, not silently cleared.
    expect(renamed.icon).toBe('🛒');
    expect(await repository.listCategories()).toHaveLength(1);
    db.close();
  });

  test('a blank name is refused instead of stored', async () => {
    const { db, repository } = makeRepository();
    await expect(repository.saveCategory({ name: '   ', color: '#4f7cff' })).rejects.toThrow('needs a name');
    db.close();
  });

  test('a deleted category no longer appears in the list', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });

    await repository.deleteCategory(category.id);

    expect(await repository.listCategories()).toEqual([]);
    // The row survives as a tombstone so the deletion can sync.
    expect((await repository.get('categories', category.id))?.deletedAt).toBe(1000);
    db.close();
  });

  test('deleting twice is a no-op rather than a second tombstone', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });

    expect(await repository.deleteCategory(category.id)).toEqual({ receipts: 0, items: 0 });
    expect(await repository.deleteCategory(category.id)).toBeNull();
    db.close();
  });
});

describe('deleting a category clears what pointed at it', () => {
  test('receipts and items keep their data but lose the dead reference', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    await seedReceipt(repository, { id: 'r-1', categoryId: category.id });
    await seedItem(repository, { id: 'i-1', receiptId: 'r-1', categoryId: category.id });

    expect(await repository.countCategoryUsage(category.id)).toEqual({ receipts: 1, items: 1 });

    const result = await repository.deleteCategory(category.id);
    expect(result).toEqual({ receipts: 1, items: 1 });

    const receipt = await repository.get('receipts', 'r-1');
    const item = await repository.get('items', 'i-1');
    expect(receipt?.categoryId).toBeNull();
    expect(item?.categoryId).toBeNull();
    // The receipt itself is untouched: only the reference went away.
    expect(receipt?.deletedAt).toBe(0);
    expect(receipt?.total).toBe(120);
    expect(item?.name).toBe('Mjölk');
    db.close();
  });

  test('the cleared rows are marked dirty so the change reaches the server', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    await seedReceipt(repository, { id: 'r-1', categoryId: category.id, dirty: 0 as const });

    await repository.deleteCategory(category.id);

    expect((await repository.get('receipts', 'r-1'))?.dirty).toBe(1);
    db.close();
  });

  test('the projection is rewritten, so a filter on the old category finds nothing', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    await seedReceipt(repository, { id: 'r-1', categoryId: category.id });

    await repository.deleteCategory(category.id);

    expect(await repository.countCategoryUsage(category.id)).toEqual({ receipts: 0, items: 0 });
    const page = await repository.queryReceipts({ categoryIds: [category.id] }, 10);
    expect(page.items).toEqual([]);
    db.close();
  });

  test('other categories are left alone', async () => {
    const { db, repository } = makeRepository();
    const doomed = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    const kept = await repository.saveCategory({ name: 'Resa', color: '#22a06b' });
    await seedReceipt(repository, { id: 'r-1', categoryId: kept.id });

    await repository.deleteCategory(doomed.id);

    expect((await repository.get('receipts', 'r-1'))?.categoryId).toBe(kept.id);
    expect((await repository.listCategories()).map((row) => row.name)).toEqual(['Resa']);
    db.close();
  });

  test('subscribers are notified once, not once per cleared row', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Mat', color: '#4f7cff' });
    for (const id of ['r-1', 'r-2', 'r-3']) {
      await seedReceipt(repository, { id, categoryId: category.id });
    }

    const events: string[] = [];
    const unsubscribe = repository.subscribe((event) => events.push(event.reason));
    await repository.deleteCategory(category.id);
    unsubscribe();

    expect(events).toEqual(['tombstone']);
    db.close();
  });
});

describe('tag CRUD', () => {
  test('tags list alphabetically', async () => {
    const { db, repository } = makeRepository();
    await repository.saveTag({ name: 'Resa', color: '#4f7cff' });
    await repository.saveTag({ name: 'Avdrag', color: '#22a06b' });

    expect((await repository.listTags()).map((row) => row.name)).toEqual(['Avdrag', 'Resa']);
    db.close();
  });

  test('usage counts distinct receipts, not links', async () => {
    const { db, repository } = makeRepository();
    const tag = await repository.saveTag({ name: 'Resa', color: '#4f7cff' });
    await repository.upsert('receiptTags', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'l-1', receiptId: 'r-1', tagId: tag.id,
    });
    await repository.upsert('receiptTags', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'l-2', receiptId: 'r-1', tagId: tag.id,
    });

    expect(await repository.countTagUsage(tag.id)).toEqual({ receipts: 1 });
    db.close();
  });

  test('deleting a tag tombstones its links so no receipt keeps a dead tag', async () => {
    const { db, repository } = makeRepository();
    const tag = await repository.saveTag({ name: 'Resa', color: '#4f7cff' });
    const other = await repository.saveTag({ name: 'Avdrag', color: '#22a06b' });
    await repository.upsert('receiptTags', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'l-1', receiptId: 'r-1', tagId: tag.id,
    });
    await repository.upsert('receiptTags', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'l-2', receiptId: 'r-1', tagId: other.id,
    });

    expect(await repository.deleteTag(tag.id)).toEqual({ links: 1 });

    expect((await repository.get('receiptTags', 'l-1'))?.deletedAt).toBe(1000);
    // The link to the surviving tag must not be collateral damage.
    expect((await repository.get('receiptTags', 'l-2'))?.deletedAt).toBe(0);
    expect(await repository.countTagUsage(tag.id)).toEqual({ receipts: 0 });
    db.close();
  });
});
