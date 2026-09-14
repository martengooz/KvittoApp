/**
 * Merging machine-written data into records a human may also be editing.
 *
 * Last-write-wins is the right default for two phones held by the same person:
 * both edits are deliberate, and the later one is what they meant. It is the
 * *wrong* rule the moment a server starts writing on its own, because the two
 * writers are not peers. A background extraction that lands three minutes after
 * the user corrected a total would win on timestamp alone and quietly undo
 * them, and they would have no way of knowing.
 *
 * So enrichment plays by a stricter set of rules than a device does:
 *
 * 1. **A reviewed receipt is closed.** Once a human marks it confirmed, nothing
 *    automatic touches it again.
 * 2. **Fill blanks, never overwrite.** A field that already has a value keeps
 *    it, whoever put it there.
 * 3. **Line items are all-or-nothing.** A receipt that already has lines keeps
 *    them; half-merging the model's list into a hand-edited one produces
 *    duplicates that are worse than no extraction at all.
 * 4. **The device's checksummed facts outrank the model's reading.** An
 *    organisation number that passed Luhn on the phone is not up for revision
 *    by a 4B model squinting at the same pixels.
 *
 * The same asymmetry applies in the other direction when the record comes back
 * down: {@link mergeIncomingReceipt} lets a local edit survive a server write
 * it never saw.
 */

import type { NormalizedExtraction } from './extraction.js';
import type { ExtractionInfo, Receipt } from './types.js';

/**
 * Marks an extraction as having come from the companion server's own model,
 * rather than from a provider the user called. The client keys its merge
 * behaviour off this, so it must not change casually.
 */
export const LOCAL_LLM_PROVIDER = 'local-llm';

/** True when this extraction was written by the server rather than a device. */
export function isMachineWritten(info: ExtractionInfo | null | undefined): boolean {
  return info?.provider === LOCAL_LLM_PROVIDER;
}

/** Why an enrichment was not applied. */
export type SkipReason =
  /** The user has reviewed and accepted this receipt. */
  | 'confirmed'
  /** The receipt is a tombstone. */
  | 'deleted'
  /** Every field the extraction offered was already filled in. */
  | 'nothing-new';

export interface EnrichmentResult {
  /** Fields to write. Empty when `skipped` is set. */
  patch: Partial<Receipt>;
  /** Names of the fields that were filled, for the log and the UI. */
  filled: string[];
  /** Fields the extraction offered but that already had a value. */
  kept: string[];
  /** True when the caller should also create the extraction's line items. */
  writeItems: boolean;
  skipped: SkipReason | null;
}

/** Scalar receipt fields the extraction can supply, filled only when blank. */
const SCALAR_FIELDS = [
  'purchasedAt',
  'total',
  'subtotal',
  'discountTotal',
  'roundingAmount',
  'depositTotal',
  'paymentMethod',
  'cardLast4',
  'receiptNumber',
  'terminalId',
  'cashier',
] as const satisfies readonly (keyof Receipt)[];

/** Merchant sub-fields, same rule. */
const MERCHANT_FIELDS = [
  'name',
  'orgNumber',
  'vatNumber',
  'address',
  'postalCode',
  'city',
  'country',
  'phone',
  'storeId',
] as const;

export interface EnrichOptions {
  /** Provenance to record on the receipt. */
  info: ExtractionInfo;
  /** True when the receipt already has live line items somewhere. */
  hasItems: boolean;
  /**
   * Allow the extraction to replace values a *previous run of the same
   * extractor* wrote. Off by default; on when an operator asks for a re-run,
   * which is the only case where overwriting machine output is intended.
   */
  replaceOwn?: boolean;
}

/**
 * Works out what an extraction is allowed to change on a receipt.
 *
 * Returns the patch rather than applying it, so the caller can put it inside
 * whatever transaction and revision scheme it uses.
 */
export function mergeEnrichment(
  receipt: Receipt,
  extraction: NormalizedExtraction,
  options: EnrichOptions,
): EnrichmentResult {
  const empty: EnrichmentResult = { patch: {}, filled: [], kept: [], writeItems: false, skipped: null };

  if (receipt.deletedAt !== 0) return { ...empty, skipped: 'deleted' };
  if (receipt.status === 'confirmed') return { ...empty, skipped: 'confirmed' };

  // A re-run may revise its own earlier answer, but only its own.
  const mayReplace = options.replaceOwn === true && isMachineWritten(receipt.extraction);

  const patch: Partial<Receipt> = {};
  const filled: string[] = [];
  const kept: string[] = [];

  for (const field of SCALAR_FIELDS) {
    const incoming = extraction[field as keyof NormalizedExtraction];
    if (incoming === null || incoming === undefined) continue;

    const current = receipt[field];
    if (current !== null && current !== undefined && !mayReplace) {
      kept.push(field);
      continue;
    }
    (patch as Record<string, unknown>)[field] = incoming;
    filled.push(field);
  }

  const merchant = { ...receipt.merchant };
  let merchantChanged = false;
  for (const field of MERCHANT_FIELDS) {
    const incoming = extraction.merchant[field];
    if (!incoming) continue;
    // The organisation number is the one field the device can *prove*, via the
    // Luhn checksum and the registry lookup that followed it. A model reading
    // the same blurred digits does not get to revise it, not even on a re-run.
    if (merchant[field] && (field === 'orgNumber' || !mayReplace)) {
      kept.push(`merchant.${field}`);
      continue;
    }
    if (merchant[field] === incoming) continue;
    merchant[field] = incoming;
    merchantChanged = true;
    filled.push(`merchant.${field}`);
  }
  if (merchantChanged) patch.merchant = merchant;

  // VAT lines are a block, not a set of fields: a partial table is misleading.
  if (extraction.vatLines.length > 0 && (receipt.vatLines.length === 0 || mayReplace)) {
    patch.vatLines = extraction.vatLines;
    filled.push('vatLines');
  } else if (extraction.vatLines.length > 0) {
    kept.push('vatLines');
  }

  // Same for the currency, which is only worth taking when it is not the
  // default the receipt was created with.
  if (extraction.currency && receipt.currency !== extraction.currency && !options.hasItems) {
    patch.currency = extraction.currency;
    filled.push('currency');
  }

  const writeItems = extraction.items.length > 0 && !options.hasItems;
  if (writeItems) {
    patch.itemCount = extraction.items.length;
    filled.push('items');
  } else if (extraction.items.length > 0) {
    kept.push('items');
  }

  if (filled.length === 0) return { ...empty, kept, skipped: 'nothing-new' };

  patch.extraction = options.info;
  // `parsed`, never `confirmed`: the whole point is that a human has not looked
  // at this yet. A draft that the model filled in is still a draft.
  if (receipt.status === 'draft' || receipt.status === 'failed') patch.status = 'parsed';

  return { patch, filled, kept, writeItems, skipped: null };
}

/**
 * Reconciles a receipt arriving from the server with a local copy that has
 * unsynced edits.
 *
 * The ordinary rule — whichever `updatedAt` is later wins the whole record —
 * is wrong here in one specific, and common, case: the server extracted from
 * the copy it had, which predates edits this device has not pushed yet. Its
 * write is newer by the clock and older by the facts.
 *
 * So when the incoming record is machine-written and the local one is dirty,
 * the two are merged field by field with the human's value winning every
 * contested field. In every other case the caller's normal conflict rule
 * applies, and this returns `null` to say so.
 */
export function mergeIncomingReceipt(local: Receipt, remote: Receipt): Receipt | null {
  if (!isMachineWritten(remote.extraction)) return null;
  if (local.dirty !== 1) return null;
  if (local.deletedAt !== 0 || remote.deletedAt !== 0) return null;

  // A reviewed local receipt takes the server's revision and nothing else.
  if (local.status === 'confirmed') {
    return { ...local, rev: remote.rev };
  }

  const merged: Receipt = { ...remote };

  for (const field of SCALAR_FIELDS) {
    const mine = local[field];
    if (mine !== null && mine !== undefined) {
      (merged as unknown as Record<string, unknown>)[field] = mine;
    }
  }

  const merchant = { ...remote.merchant };
  for (const field of MERCHANT_FIELDS) {
    if (local.merchant[field]) merchant[field] = local.merchant[field];
  }
  merged.merchant = merchant;

  if (local.vatLines.length > 0) merged.vatLines = local.vatLines;
  if (local.categoryId) merged.categoryId = local.categoryId;
  if (local.notes) merged.notes = local.notes;
  if (local.companyId) merged.companyId = local.companyId;
  // The device's own reading of the paper is its own; the server never has it.
  if (local.ocr) merged.ocr = local.ocr;
  // Item rows sync separately and are counted locally, so the local count is
  // the accurate one for this device.
  merged.itemCount = local.itemCount;

  // Still dirty: this merged record differs from what the server holds, so it
  // has to go back up. And newer than both inputs, so it wins when it gets
  // there rather than being bounced as stale.
  merged.rev = remote.rev;
  merged.dirty = 1;
  merged.updatedAt = Math.max(local.updatedAt, remote.updatedAt) + 1;

  return merged;
}
