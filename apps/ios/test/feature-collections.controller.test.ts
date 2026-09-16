import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Category, type Tag } from '@kvitto/shared/domain';

import { CollectionsFeatureController } from '../src/features/collections/controller';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function seedMeta(now: number) {
  return {
    updatedAt: now,
    deletedAt: 0,
    rev: 0,
    dirty: 1 as const,
  };
}

describe('feature-collections controller', () => {
  test('builds month/category/merchant/tag summaries from paginated receipt access', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());

    const food: Category = {
      ...seedMeta(100),
      id: 'cat-food',
      name: 'Food',
      color: '#44aa55',
      icon: 'F',
      parentId: null,
      scope: 'both',
      sortOrder: 1,
    };
    const home: Category = {
      ...seedMeta(101),
      id: 'cat-home',
      name: 'Home',
      color: '#aa8844',
      icon: 'H',
      parentId: null,
      scope: 'both',
      sortOrder: 2,
    };
    const weekly: Tag = {
      ...seedMeta(102),
      id: 'tag-weekly',
      name: 'Weekly',
      color: '#3366aa',
    };

    await repo.upsert('categories', food);
    await repo.upsert('categories', home);
    await repo.upsert('tags', weekly);

    for (let i = 0; i < 1300; i += 1) {
      const receiptId = `r-${i}`;
      const categoryId = i % 2 === 0 ? 'cat-food' : 'cat-home';
      await repo.upsert('receipts', {
        ...seedMeta(1000 + i),
        id: receiptId,
        merchant: { ...emptyMerchant(), name: i % 3 === 0 ? 'ICA Maxi' : 'Coop Forum' },
        purchasedAt: `2026-${String((i % 9) + 1).padStart(2, '0')}-15T09:00:00.000Z`,
        currency: 'SEK',
        total: 50 + (i % 25),
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
        categoryId,
        companyId: null,
        notes: null,
        source: 'manual',
        imageId: null,
        originalImageId: null,
        thumbId: null,
        status: 'confirmed',
        extraction: null,
        ocr: null,
        itemCount: 1,
      });

      await repo.upsert('items', {
        ...seedMeta(3000 + i),
        id: `i-${i}`,
        receiptId,
        lineNo: 0,
        name: i % 2 === 0 ? 'Banan' : 'Diskmedel',
        rawName: null,
        searchName: i % 2 === 0 ? 'banan' : 'diskmedel',
        quantity: 1,
        unit: 'st',
        unitPrice: null,
        totalPrice: 50 + (i % 25),
        discount: null,
        vatRate: null,
        categoryId,
        ean: null,
        deposit: null,
        isDeposit: false,
        isDiscount: false,
        notes: null,
      });

      if (i % 2 === 0) {
        await repo.upsert('receiptTags', {
          ...seedMeta(5000 + i),
          id: `rt:${receiptId}:tag-weekly`,
          receiptId,
          tagId: 'tag-weekly',
        });
      }
    }

    const originalQuery = repo.queryReceipts.bind(repo);
    let queryCalls = 0;
    repo.queryReceipts = async (...args) => {
      queryCalls += 1;
      return originalQuery(...args);
    };

    const controller = new CollectionsFeatureController(repo);
    await controller.refresh();

    const snapshot = controller.getSnapshot();
    expect(snapshot.byMonth.length).toBeGreaterThan(0);
    expect(snapshot.byCategory.length).toBeGreaterThan(0);
    expect(snapshot.byMerchant.length).toBeGreaterThan(0);
    expect(snapshot.byTag.length).toBeGreaterThan(0);
    expect(queryCalls).toBeGreaterThan(1);
  });
});
