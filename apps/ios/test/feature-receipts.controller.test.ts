import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Category, type Receipt, type ReceiptItem, type Tag } from '@kvitto/shared/domain';

import { ReceiptsFeatureController } from '../src/features/receipts/controller';
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

async function seedReceipt(repo: IosDataRepository, index: number, categoryId: string | null): Promise<Receipt> {
  return repo.upsert('receipts', {
    ...seedMeta(1000 + index),
    id: `r-${index}`,
    merchant: {
      ...emptyMerchant(),
      name: index % 2 === 0 ? 'ICA Maxi' : 'Coop',
    },
    purchasedAt: `2026-02-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    currency: 'SEK',
    total: Number((index % 150) + 10),
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
    notes: index % 40 === 0 ? 'manual review needed' : null,
    source: index % 5 === 0 ? 'camera' : 'manual',
    imageId: null,
    originalImageId: null,
    thumbId: index % 9 === 0 ? `thumb-${index}` : null,
    status: index % 37 === 0 ? 'failed' : index % 7 === 0 ? 'parsed' : 'confirmed',
    extraction: index % 7 === 0
      ? {
          provider: 'openai',
          model: 'gpt-4.1-mini',
          at: 2000 + index,
          durationMs: 400,
          inputTokens: 100,
          outputTokens: 80,
          warnings: index % 21 === 0 ? ['missing VAT line'] : [],
          error: null,
        }
      : null,
    ocr: null,
    itemCount: 0,
  });
}

async function seedItem(repo: IosDataRepository, receiptId: string, index: number): Promise<ReceiptItem> {
  return repo.upsert('items', {
    ...seedMeta(2000 + index),
    id: `i-${index}`,
    receiptId,
    lineNo: 0,
    name: index % 3 === 0 ? 'Havremjolk' : 'Brod',
    rawName: null,
    searchName: index % 3 === 0 ? 'havremjolk' : 'brod',
    quantity: 1,
    unit: 'st',
    unitPrice: null,
    totalPrice: index % 3 === 0 ? 25 : 18,
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

async function seedTaxonomy(repo: IosDataRepository): Promise<void> {
  const category: Category = {
    ...seedMeta(900),
    id: 'cat-food',
    name: 'Food',
    color: '#44aa55',
    icon: 'F',
    parentId: null,
    scope: 'both',
    sortOrder: 1,
  };
  const tag: Tag = {
    ...seedMeta(901),
    id: 'tag-weekly',
    name: 'Weekly',
    color: '#2255aa',
  };
  await repo.upsert('categories', category);
  await repo.upsert('tags', tag);
}

describe('feature-receipts controller', () => {
  test('paginates list and keeps image handling out of list rows', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());
    await seedTaxonomy(repo);

    for (let i = 0; i < 2100; i += 1) {
      await seedReceipt(repo, i, i % 2 === 0 ? 'cat-food' : null);
      await seedItem(repo, `r-${i}`, i);
    }

    const controller = new ReceiptsFeatureController(repo, 120);
    await controller.refresh();

    const snapshot = controller.getSnapshot();
    expect(snapshot.list.rows).toHaveLength(120);
    expect(snapshot.list.hasMore).toBe(true);

    const first = snapshot.list.rows[0]!;
    expect(first.hasThumbnail === true || first.hasThumbnail === false).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(first, 'imageId')).toBe(false);
    expect(first.accessibilityLabel.length).toBeGreaterThan(0);

    await controller.loadNextPage();
    const page2 = controller.getSnapshot();
    expect(page2.list.rows.length).toBe(240);

    await controller.setSearchQuery('havremjolk');
    const searched = controller.getSnapshot();
    expect(searched.list.rows.length).toBeGreaterThan(0);
    expect(searched.list.rows.every((row) => row.id.startsWith('r-'))).toBe(true);
  });

  test('supports details edit, review status, tombstone delete and undo', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());
    await seedTaxonomy(repo);

    await seedReceipt(repo, 1, 'cat-food');
    await seedItem(repo, 'r-1', 1);
    await repo.upsert('receiptTags', {
      ...seedMeta(3000),
      id: 'rt:r-1:tag-weekly',
      receiptId: 'r-1',
      tagId: 'tag-weekly',
    });

    const controller = new ReceiptsFeatureController(repo, 50);
    await controller.refresh();
    await controller.selectReceipt('r-1');

    const before = controller.getSnapshot().details;
    expect(before).not.toBeNull();
    expect(before?.provenance.status).toBeDefined();

    await controller.saveReceiptEdits({
      id: 'r-1',
      merchantName: 'Updated Store',
      purchasedAt: '2026-02-08T12:00:00.000Z',
      notes: 'checked',
      status: 'parsed',
      categoryId: 'cat-food',
      tagIds: ['tag-weekly'],
    });

    await controller.markReviewed('r-1');
    const reviewed = await repo.getReceipt('r-1');
    expect(reviewed?.status).toBe('confirmed');

    await controller.deleteReceipt('r-1');
    const tombstoned = await repo.getReceipt('r-1');
    expect(tombstoned?.deletedAt).toBeGreaterThan(0);

    await controller.undoDelete();
    const restored = await repo.getReceipt('r-1');
    expect(restored?.deletedAt).toBe(0);
  });
});
