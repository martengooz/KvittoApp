/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { createExtractionRunner } from '../src/ai/extraction-runner';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import type { AdapterSettings } from '../src/ai/types';

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
    source: 'camera', imageId: 'img-1', originalImageId: 'img-0', thumbId: null,
    status: 'draft', extraction: null, ocr: null, itemCount: 0,
    ...overrides,
  });
}

const SETTINGS: AdapterSettings = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  apiKey: 'sk-test',
  maxOutputTokens: 4096,
  effort: 'auto',
  structuredOutput: true,
  extraInstructions: '',
};

function fakeNative(overrides: Record<string, unknown> = {}) {
  return {
    getBlobMetadata: async () => ({
      sha256Id: 'img-1',
      uri: 'file:///blobs/img-1.jpg',
      mimeType: 'image/jpeg',
      byteSize: 10,
      width: 10,
      height: 10,
    }),
    readFileChunkBase64: async (_uri: string, offset: number) =>
      offset === 0 ? globalThis.btoa('fake-image-bytes') : '',
    ...overrides,
  } as never;
}

describe('extraction runner gating', () => {
  test('AI turned off reports unsupported and touches nothing', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    const run = createExtractionRunner({
      repository,
      native: fakeNative(),
      getSettings: async () => ({ mode: 'none', settings: null }),
    });

    expect(await run({ receiptId: 'r-1', sourceVersion: 1000 })).toBe('unsupported');
    // No failure is recorded: not configured is not an error.
    expect((await repository.getReceipt('r-1'))?.extraction).toBeNull();
    expect((await repository.getReceipt('r-1'))?.status).toBe('draft');
    db.close();
  });

  test('a receipt with no image is refused before any provider call', async () => {
    const { db, repository } = makeRepository();
    await seed(repository, { imageId: null, originalImageId: null });

    const run = createExtractionRunner({
      repository,
      native: fakeNative(),
      getSettings: async () => ({ mode: 'remote', settings: SETTINGS }),
    });

    await expect(run({ receiptId: 'r-1', sourceVersion: 1000 })).rejects.toThrow(
      'missing-image-for-extraction',
    );
    db.close();
  });

  test('a missing receipt is refused', async () => {
    const { db, repository } = makeRepository();

    const run = createExtractionRunner({
      repository,
      native: fakeNative(),
      getSettings: async () => ({ mode: 'remote', settings: SETTINGS }),
    });

    await expect(run({ receiptId: 'nope', sourceVersion: 1 })).rejects.toThrow('missing-receipt:nope');
    db.close();
  });

  test('a stale source is suppressed rather than overwritten', async () => {
    const { db, repository } = makeRepository();
    // The receipt has moved on past the version this job claimed.
    await seed(repository, { updatedAt: 9000 });

    const run = createExtractionRunner({
      repository,
      native: fakeNative(),
      getSettings: async () => ({ mode: 'remote', settings: SETTINGS }),
    });

    expect(await run({ receiptId: 'r-1', sourceVersion: 1000 })).toBe('stale');
    // A newer job will do the work; this one must not write an older result.
    expect((await repository.getReceipt('r-1'))?.extraction).toBeNull();
    db.close();
  });

  test('a missing API key fails the receipt with a visible reason', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    const run = createExtractionRunner({
      repository,
      native: fakeNative(),
      getSettings: async () => ({
        mode: 'remote',
        settings: { ...SETTINGS, apiKey: undefined },
      }),
    });

    await expect(run({ receiptId: 'r-1', sourceVersion: 1000 })).rejects.toThrow();

    const receipt = await repository.getReceipt('r-1');
    // The reason has to land on the receipt, not only in a log: the extraction
    // screen is where a user looks to find out why nothing happened.
    expect(receipt?.status).toBe('failed');
    expect(receipt?.extraction?.error).toContain('API-nyckel');
    db.close();
  });

  test('a provider failure is recorded and rethrown so the job can retry', async () => {
    const { db, repository } = makeRepository();
    await seed(repository);

    const run = createExtractionRunner({
      repository,
      native: fakeNative({
        getBlobMetadata: async () => null,
      }),
      getSettings: async () => ({ mode: 'remote', settings: SETTINGS }),
    });

    await expect(run({ receiptId: 'r-1', sourceVersion: 1000 })).rejects.toThrow(
      'missing-image-metadata',
    );
    db.close();
  });
});
