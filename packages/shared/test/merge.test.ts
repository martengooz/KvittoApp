import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_SYNC_META,
  LOCAL_LLM_PROVIDER,
  emptyMerchant,
  mergeEnrichment,
  mergeIncomingReceipt,
} from '../dist/index.js';
import type { ExtractionInfo, NormalizedExtraction, Receipt } from '../dist/index.js';

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    ...EMPTY_SYNC_META,
    updatedAt: 1000,
    id: 'r1',
    merchant: emptyMerchant(),
    purchasedAt: null,
    currency: 'SEK',
    total: null,
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
    source: 'camera',
    imageId: 'img',
    originalImageId: null,
    thumbId: null,
    status: 'draft',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  };
}

function extraction(overrides: Partial<NormalizedExtraction> = {}): NormalizedExtraction {
  return {
    merchant: { ...emptyMerchant(), name: 'ICA Kvantum', orgNumber: '556012-5790' },
    purchasedAt: '2026-03-15T14:22:00',
    currency: 'SEK',
    total: 431.5,
    subtotal: null,
    discountTotal: null,
    roundingAmount: null,
    depositTotal: null,
    vatLines: [{ rate: 12, net: 385.27, vat: 46.23, gross: 431.5 }],
    paymentMethod: 'kort',
    cardLast4: '8618',
    receiptNumber: null,
    terminalId: null,
    cashier: null,
    items: [
      {
        name: 'Mjölk', rawName: 'MJOLK', searchName: 'mjolk', quantity: 1, unit: 'st',
        unitPrice: null, totalPrice: 15.9, discount: null, vatRate: 12, ean: null,
        deposit: null, isDeposit: false, isDiscount: false,
      },
    ],
    confidence: 0.8,
    warnings: [],
    ...overrides,
  };
}

const info: ExtractionInfo = {
  provider: LOCAL_LLM_PROVIDER,
  model: 'qwen3-vl:4b',
  at: 5000,
  durationMs: 4200,
  inputTokens: null,
  outputTokens: null,
  warnings: [],
  error: null,
};

test('an empty receipt is filled in and marked parsed', () => {
  const result = mergeEnrichment(receipt(), extraction(), { info, hasItems: false });

  assert.equal(result.skipped, null);
  assert.equal(result.patch.total, 431.5);
  assert.equal(result.patch.purchasedAt, '2026-03-15T14:22:00');
  assert.equal(result.patch.status, 'parsed');
  assert.equal(result.writeItems, true);
  assert.equal(result.patch.itemCount, 1);
});

test('a confirmed receipt is never touched', () => {
  const result = mergeEnrichment(receipt({ status: 'confirmed' }), extraction(), {
    info,
    hasItems: false,
  });

  assert.equal(result.skipped, 'confirmed');
  assert.deepEqual(result.patch, {});
});

test('a value the user already entered survives', () => {
  const mine = receipt({ total: 999, paymentMethod: 'kontant' });
  const result = mergeEnrichment(mine, extraction(), { info, hasItems: false });

  assert.equal(result.patch.total, undefined, 'the model must not revise a filled total');
  assert.equal(result.patch.paymentMethod, undefined);
  assert.ok(result.kept.includes('total'));
  // Blank fields are still filled — a partial edit does not close the receipt.
  assert.equal(result.patch.purchasedAt, '2026-03-15T14:22:00');
});

test('existing line items are left alone rather than duplicated', () => {
  const result = mergeEnrichment(receipt({ itemCount: 12 }), extraction(), {
    info,
    hasItems: true,
  });

  assert.equal(result.writeItems, false);
  assert.equal(result.patch.itemCount, undefined);
  assert.ok(result.kept.includes('items'));
});

test('a verified organisation number outranks the model, even on a re-run', () => {
  const mine = receipt({
    merchant: { ...emptyMerchant(), orgNumber: '969630-6944' },
    extraction: info,
  });
  const guessed = extraction({
    merchant: { ...emptyMerchant(), name: 'ICA Kvantum', orgNumber: '556012-5790' },
  });

  const result = mergeEnrichment(mine, guessed, { info, hasItems: false, replaceOwn: true });
  // The patch carries the whole merchant object, so the guarantee is that the
  // number in it is still the device's, not that the field is absent.
  assert.equal(result.patch.merchant?.orgNumber, '969630-6944');
  assert.ok(result.kept.includes('merchant.orgNumber'));
  // The name was blank, so that one is taken.
  assert.equal(result.patch.merchant?.name, 'ICA Kvantum');
});

test('a re-run may revise what a previous run of the same extractor wrote', () => {
  const machineFilled = receipt({ total: 100, extraction: info, status: 'parsed' });

  const conservative = mergeEnrichment(machineFilled, extraction(), { info, hasItems: false });
  assert.equal(conservative.patch.total, undefined);

  const rerun = mergeEnrichment(machineFilled, extraction(), {
    info,
    hasItems: false,
    replaceOwn: true,
  });
  assert.equal(rerun.patch.total, 431.5);
});

test('an extraction that adds nothing reports so instead of bumping the record', () => {
  const complete = receipt({
    total: 431.5,
    purchasedAt: '2026-03-15T14:22:00',
    paymentMethod: 'kort',
    cardLast4: '8618',
    merchant: { ...emptyMerchant(), name: 'ICA Kvantum', orgNumber: '556012-5790' },
    vatLines: [{ rate: 12, net: 385.27, vat: 46.23, gross: 431.5 }],
    itemCount: 1,
  });

  const result = mergeEnrichment(complete, extraction(), { info, hasItems: true });
  assert.equal(result.skipped, 'nothing-new');
});

// --- the record coming back down ------------------------------------------

test('an unsynced local edit beats the server extraction that never saw it', () => {
  // The user fixed the total at t=2000 and has not pushed. The server extracted
  // at t=5000 from the copy it had, which still said null.
  const local = receipt({ total: 999, notes: 'kolla momsen', updatedAt: 2000, dirty: 1 });
  const remote = receipt({
    total: 431.5,
    purchasedAt: '2026-03-15T14:22:00',
    updatedAt: 5000,
    rev: 42,
    dirty: 0,
    status: 'parsed',
    extraction: info,
  });

  const merged = mergeIncomingReceipt(local, remote);
  assert.ok(merged, 'a machine write over a dirty local record must merge, not replace');
  assert.equal(merged.total, 999, "the user's correction survives");
  assert.equal(merged.notes, 'kolla momsen');
  // And the field the user never touched is taken from the server.
  assert.equal(merged.purchasedAt, '2026-03-15T14:22:00');
  // It differs from both sides, so it has to go back up and must win when it does.
  assert.equal(merged.dirty, 1);
  assert.equal(merged.rev, 42);
  assert.ok(merged.updatedAt > 5000);
});

test('a receipt a human confirmed keeps everything and only takes the revision', () => {
  const local = receipt({ status: 'confirmed', total: 999, updatedAt: 2000, dirty: 1 });
  const remote = receipt({ total: 431.5, updatedAt: 5000, rev: 7, extraction: info });

  const merged = mergeIncomingReceipt(local, remote);
  assert.equal(merged?.total, 999);
  assert.equal(merged?.status, 'confirmed');
  assert.equal(merged?.rev, 7);
});

test('an ordinary device-to-device change is left to the normal conflict rule', () => {
  const local = receipt({ total: 999, updatedAt: 2000, dirty: 1 });
  const fromAnotherPhone = receipt({
    total: 431.5,
    updatedAt: 5000,
    extraction: { ...info, provider: 'anthropic' },
  });

  assert.equal(mergeIncomingReceipt(local, fromAnotherPhone), null);
  // And a clean local record has nothing to protect.
  assert.equal(mergeIncomingReceipt(receipt({ dirty: 0 }), receipt({ extraction: info })), null);
});
