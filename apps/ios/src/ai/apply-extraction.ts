import {
  normalizeSearchName,
  type ExtractionInfo,
  type ID,
  type Receipt,
  type ReceiptItem,
} from '@kvitto/shared/domain';
import type { NormalizedExtraction } from '@kvitto/shared/domain';

import type { IosDataRepository } from '../data/repository';
import type { ProviderResponse } from './types';

export interface ApplyExtractionInput {
  receiptId: ID;
  extraction: NormalizedExtraction;
  response: ProviderResponse;
  /** Warnings from the adapter, which include normalisation problems. */
  warnings: string[];
  now: number;
}

export interface ApplyExtractionResult {
  itemsWritten: number;
  itemsRemoved: number;
}

/**
 * A line's id is derived from its receipt and line number, so re-running
 * extraction overwrites the previous run's lines instead of appending a second
 * copy of the receipt. Extraction is retried on failure and re-run after a
 * re-crop, so this has to be idempotent or a receipt grows every time.
 */
function itemIdFor(receiptId: ID, lineNo: number): ID {
  return `ai:${receiptId}:${lineNo}`;
}

/**
 * Writes a provider's extraction onto a receipt and its line items.
 *
 * Applied in one transaction: a receipt whose header says one total while its
 * lines are from the previous run is worse than either version on its own.
 */
export async function applyExtraction(
  repository: IosDataRepository,
  input: ApplyExtractionInput,
): Promise<ApplyExtractionResult> {
  const current = await repository.getReceipt(input.receiptId);
  if (!current) throw new Error(`missing-receipt:${input.receiptId}`);

  const { extraction, response } = input;
  const info: ExtractionInfo = {
    provider: response.provider,
    model: response.model,
    at: input.now,
    durationMs: response.durationMs,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    warnings: [...input.warnings, ...extraction.warnings],
    error: null,
  };

  const existing = await repository.listReceiptItems(input.receiptId);
  const keptIds = new Set<ID>();
  let itemsWritten = 0;
  let itemsRemoved = 0;

  await repository.runInTransaction(async () => {
    for (const [lineNo, line] of extraction.items.entries()) {
      const id = itemIdFor(input.receiptId, lineNo);
      keptIds.add(id);

      const item: ReceiptItem = {
        id,
        receiptId: input.receiptId,
        lineNo,
        name: line.name,
        rawName: line.rawName,
        searchName: line.searchName || normalizeSearchName(line.name),
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        totalPrice: line.totalPrice,
        discount: line.discount,
        vatRate: line.vatRate,
        // Extraction does not assign categories; a user's choice is not
        // overwritten by a re-run, so an existing one is carried forward.
        categoryId: existing.find((row) => row.id === id)?.categoryId ?? null,
        ean: line.ean,
        deposit: line.deposit,
        isDeposit: line.isDeposit,
        isDiscount: line.isDiscount,
        notes: null,
        updatedAt: input.now,
        deletedAt: 0,
        rev: existing.find((row) => row.id === id)?.rev ?? 0,
        dirty: 1,
      };

      await repository.upsert('items', item);
      itemsWritten += 1;
    }

    // A shorter result than last time must not leave the old tail behind.
    for (const row of existing) {
      if (keptIds.has(row.id)) continue;
      await repository.deleteItem(row.id);
      itemsRemoved += 1;
    }

    const next: Partial<Receipt> = {
      merchant: extraction.merchant,
      purchasedAt: extraction.purchasedAt,
      currency: extraction.currency,
      total: extraction.total,
      subtotal: extraction.subtotal,
      discountTotal: extraction.discountTotal,
      roundingAmount: extraction.roundingAmount,
      depositTotal: extraction.depositTotal,
      vatLines: extraction.vatLines,
      paymentMethod: extraction.paymentMethod,
      cardLast4: extraction.cardLast4,
      receiptNumber: extraction.receiptNumber,
      terminalId: extraction.terminalId,
      cashier: extraction.cashier,
      extraction: info,
      // Set explicitly: `upsert('items', …)` does not refresh the receipt's
      // count the way `addItem`/`deleteItem` do, and this patch is built from a
      // receipt read before the lines were written.
      itemCount: extraction.items.length,
      // A user who already confirmed this receipt is not walked back to
      // "parsed" by a later extraction pass.
      status: current.status === 'confirmed' ? 'confirmed' : 'parsed',
    };

    await repository.updateReceipt(input.receiptId, next);
  });

  return { itemsWritten, itemsRemoved };
}

/** Records a failed extraction on the receipt, so the reason is visible. */
export async function applyExtractionFailure(
  repository: IosDataRepository,
  receiptId: ID,
  provider: string,
  model: string,
  message: string,
  now: number,
): Promise<void> {
  const current = await repository.getReceipt(receiptId);
  if (!current) return;

  await repository.updateReceipt(receiptId, {
    status: 'failed',
    extraction: {
      provider,
      model,
      at: now,
      durationMs: null,
      inputTokens: null,
      outputTokens: null,
      warnings: [],
      error: message,
    },
  });
}
