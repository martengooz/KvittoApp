/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type NormalizedExtraction, type Receipt } from '@kvitto/shared/domain';

import { applyExtraction, applyExtractionFailure } from '../src/ai/apply-extraction';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import type { ProviderResponse } from '../src/ai/types';

const RESPONSE: ProviderResponse = {
  raw: {},
  model: 'claude-opus-5',
  provider: 'anthropic',
  inputTokens: 900,
  outputTokens: 120,
  durationMs: 1234,
};

function makeRepository(now = 2000) {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => now) };
}

async function seed(repository: IosDataRepository, overrides: Partial<Receipt> = {}): Promise<void> {
  await repository.upsert('receipts', {
    updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
    id: 'r-1',
    merchant: emptyMerchant(),
    purchasedAt: null, currency: 'SEK', total: null, subtotal: null,
    discountTotal: null, roundingAmount: null, depositTotal: null, vatLines: [],
    paymentMethod: null, cardLast4: null, receiptNumber: null, terminalId: null,
    cashier: null, categoryId: null, companyId: null, notes: null,
    source: 'camera', imageId: null, originalImageId: null, thumbId: null,
    status: 'draft', extraction: null, ocr: null, itemCount: 0,
    ...overrides,
  });
}

function extractionWith(items: NormalizedExtraction['items']): NormalizedExtraction {
  return {
    merchant: { ...emptyMerchant(), name: 'ICA Maxi' },
    purchasedAt: '2026-02-10T12:00:00.000Z',
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
    items,
    confidence: 0.9,
    warnings: ['total did not match the sum of items'],
  };
}

function line(name: string, totalPrice: number): NormalizedExtraction['items'][number] {
  return {
    name,
    rawName: name,
    searchName: name.toLowerCase(),
    quantity: 1,
    unit: 'st',
    unitPrice: totalPrice,
    totalPrice,
    discount: null,
    vatRate: null,
    ean: null,
    deposit: null,
    isDeposit: false,
    isDiscount: false,
  };
}

describe('applying an extraction', () => {
  test('writes the receipt fields, the lines, and the provenance', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    const result = await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mjölk', 20), line('Bröd', 30)]),
      response: RESPONSE,
      warnings: ['adapter retried once'],
      now: 2000,
    });

    expect(result.itemsWritten).toBe(2);
    const receipt = await repository.getReceipt('r-1');
    expect(receipt?.merchant.name).toBe('ICA Maxi');
    expect(receipt?.total).toBe(100);
    expect(receipt?.status).toBe('parsed');
    expect(receipt?.extraction?.provider).toBe('anthropic');
    expect(receipt?.extraction?.inputTokens).toBe(900);
    // Adapter and normaliser warnings both reach the receipt.
    expect(receipt?.extraction?.warnings).toEqual([
      'adapter retried once',
      'total did not match the sum of items',
    ]);
    expect((await repository.listReceiptItems('r-1')).map((item) => item.name)).toEqual(['Mjölk', 'Bröd']);
    db.close();
  });

  test('re-running replaces the lines instead of appending a second copy', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mjölk', 20), line('Bröd', 30)]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });
    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mellanmjölk', 22), line('Bröd', 30)]),
      response: RESPONSE,
      warnings: [],
      now: 3000,
    });

    const items = await repository.listReceiptItems('r-1');
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.name)).toEqual(['Mellanmjölk', 'Bröd']);
    db.close();
  });

  test('a shorter second result does not leave the old tail behind', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('A', 1), line('B', 2), line('C', 3)]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });
    const result = await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('A', 1)]),
      response: RESPONSE,
      warnings: [],
      now: 3000,
    });

    expect(result.itemsRemoved).toBe(2);
    expect((await repository.listReceiptItems('r-1')).map((item) => item.name)).toEqual(['A']);
    db.close();
  });

  test('a category the user chose survives a re-run', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);
    const category = await repository.saveCategory({ name: 'Livsmedel', color: '#4f7cff' });

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mjölk', 20)]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });

    const [item] = await repository.listReceiptItems('r-1');
    await repository.updateItem(item!.id, { categoryId: category.id });

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mjölk', 20)]),
      response: RESPONSE,
      warnings: [],
      now: 3000,
    });

    // Extraction does not assign categories, so it must not clear one either.
    expect((await repository.listReceiptItems('r-1'))[0]!.categoryId).toBe(category.id);
    db.close();
  });

  test('a confirmed receipt is not walked back to parsed', async () => {
    const { db, repository } = makeRepository();
    await seed(repository, { status: 'confirmed' });

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('Mjölk', 20)]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });

    expect((await repository.getReceipt('r-1'))?.status).toBe('confirmed');
    db.close();
  });

  test('an extraction with no lines is applied without error', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    const result = await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });

    expect(result.itemsWritten).toBe(0);
    expect((await repository.getReceipt('r-1'))?.merchant.name).toBe('ICA Maxi');
    db.close();
  });

  test('a missing receipt is refused rather than silently ignored', async () => {
    const { db, repository } = makeRepository();

    await expect(
      applyExtraction(repository, {
        receiptId: 'nope',
        extraction: extractionWith([]),
        response: RESPONSE,
        warnings: [],
        now: 2000,
      }),
    ).rejects.toThrow('missing-receipt:nope');
    db.close();
  });

  test('the item count on the receipt follows the lines written', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    await applyExtraction(repository, {
      receiptId: 'r-1',
      extraction: extractionWith([line('A', 1), line('B', 2)]),
      response: RESPONSE,
      warnings: [],
      now: 2000,
    });

    expect((await repository.getReceipt('r-1'))?.itemCount).toBe(2);
    db.close();
  });
});

describe('recording a failed extraction', () => {
  test('the reason is stored on the receipt so the OCR screen can show it', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    await applyExtractionFailure(repository, 'r-1', 'anthropic', 'claude-opus-5', 'provider returned 429', 2000);

    const receipt = await repository.getReceipt('r-1');
    expect(receipt?.status).toBe('failed');
    expect(receipt?.extraction?.error).toBe('provider returned 429');
    db.close();
  });

  test('a missing receipt is a no-op, not a throw', async () => {
    const { db, repository } = makeRepository();
    await expect(
      applyExtractionFailure(repository, 'nope', 'anthropic', 'm', 'boom', 2000),
    ).resolves.toBeUndefined();
    db.close();
  });
});
