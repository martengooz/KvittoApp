import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { CollectionsFeatureController } from '../src/features/collections/controller';
import { PurchasesFeatureController } from '../src/features/purchases/controller';
import { ReceiptsFeatureController } from '../src/features/receipts/controller';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

async function seedReceipt(repo: IosDataRepository, id: string): Promise<Receipt> {
  const receipt = await repo.upsert('receipts', {
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1 as const,
    id,
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
  });
  await repo.addItem(id, { id: `${id}-item`, name: 'Havremjolk', totalPrice: 24.9 });
  return receipt;
}

/**
 * `useSyncExternalStore` calls `getSnapshot()` on every render and compares the
 * result with `Object.is`. A controller that builds a fresh object each call
 * therefore re-renders forever ("Maximum update depth exceeded") as soon as its
 * screen mounts. These tests pin the identity contract for every controller that
 * backs a tab.
 */
describe('controller snapshot identity', () => {
  test('receipts snapshot is stable between changes and fresh after one', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seedReceipt(repository, 'r-1');

    const controller = new ReceiptsFeatureController(repository, 10);
    await controller.refresh();

    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);
    expect(controller.getSnapshot()).toBe(first);

    await controller.refresh();
    expect(controller.getSnapshot()).not.toBe(first);
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    db.close();
  });

  test('purchases snapshot is stable between changes and fresh after one', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seedReceipt(repository, 'r-1');

    const controller = new PurchasesFeatureController(repository, 10);
    await controller.refresh();

    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);

    await controller.refresh();
    expect(controller.getSnapshot()).not.toBe(first);
    db.close();
  });

  test('collections snapshot is stable between changes and fresh after one', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seedReceipt(repository, 'r-1');

    const controller = new CollectionsFeatureController(repository);
    await controller.refresh();

    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);

    await controller.refresh();
    expect(controller.getSnapshot()).not.toBe(first);
    db.close();
  });
});
