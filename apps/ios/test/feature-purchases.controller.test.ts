import { describe, expect, test } from '@jest/globals';
import { emptyMerchant } from '@kvitto/shared/domain';

import { PurchasesFeatureController } from '../src/features/purchases/controller';
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

describe('feature-purchases controller', () => {
  test('global search is paginated and price history is stable for large seed sets', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());

    for (let i = 0; i < 1900; i += 1) {
      const receiptId = `r-${i}`;
      await repo.upsert('receipts', {
        ...seedMeta(1000 + i),
        id: receiptId,
        merchant: { ...emptyMerchant(), name: i % 2 === 0 ? 'ICA Maxi' : 'Willys' },
        purchasedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
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
        status: 'confirmed',
        extraction: null,
        ocr: null,
        itemCount: 1,
      });

      await repo.upsert('items', {
        ...seedMeta(2000 + i),
        id: `i-${i}`,
        receiptId,
        lineNo: 0,
        name: i % 3 === 0 ? 'Havremjolk' : 'Pasta',
        rawName: null,
        searchName: i % 3 === 0 ? 'havremjolk' : 'pasta',
        quantity: 1,
        unit: 'st',
        unitPrice: null,
        totalPrice: i % 3 === 0 ? 20 + (i % 5) : 15 + (i % 4),
        discount: null,
        vatRate: null,
        categoryId: null,
        ean: null,
        deposit: null,
        isDeposit: false,
        isDiscount: false,
        notes: null,
      });
    }

    const controller = new PurchasesFeatureController(repo, 140);
    await controller.refresh();

    const page1 = controller.getSnapshot();
    expect(page1.rows).toHaveLength(140);
    expect(page1.hasMore).toBe(true);

    await controller.setSearchQuery('havremjolk');
    const searched = controller.getSnapshot();
    expect(searched.rows.length).toBeGreaterThan(0);

    controller.selectSearchName('havremjolk');
    const withHistory = controller.getSnapshot();
    expect(withHistory.priceHistory.length).toBeGreaterThan(0);
    expect(withHistory.priceHistory.length).toBeLessThanOrEqual(20);

    for (const point of withHistory.priceHistory) {
      expect(point.price).toBeGreaterThan(0);
      expect(point.merchantName.length).toBeGreaterThan(0);
    }
  });
});
