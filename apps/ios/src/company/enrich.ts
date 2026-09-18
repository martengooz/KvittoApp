import { NAME_MATCH_THRESHOLD, matchCompanyName, type Company, type Receipt } from '@kvitto/shared';
import type { LookupFailure } from '@kvitto/shared';

import type { CompanyLookupService } from './lookup';

export interface CompanyEnrichmentInput {
  lookup: CompanyLookupService;
  receipt: Receipt;
  /** The OCR text, used both to pick search terms and to verify the answer. */
  receiptText: string;
  /** The best organisation number OCR found, if any. */
  orgNumber: { digits: string; formatted: string } | null;
  /**
   * Whether the network may be used. False still allows a cache hit: a company
   * already stored is free, so the switch gates the call, never the lookup.
   */
  autoLookup: boolean;
}

export interface CompanyEnrichmentResult {
  /** Fields to merge into the receipt patch. Empty when nothing was found. */
  patch: Partial<Pick<Receipt, 'companyId' | 'merchant'>>;
  company: Company | null;
  lookup: 'cached' | 'fetched' | null;
  /** Why the lookup did nothing, when it did nothing. */
  lookupReason: LookupFailure | null;
  /** True when the company was found from the shop's name, not its number. */
  foundByName: boolean;
  filled: Array<'orgNumber' | 'companyName'>;
}

const NOTHING: CompanyEnrichmentResult = {
  patch: {},
  company: null,
  lookup: null,
  lookupReason: null,
  foundByName: false,
  filled: [],
};

/**
 * Links a receipt to a company in the registry.
 *
 * Runs after OCR, on the text OCR produced. It is checked rather than
 * generated: an organisation number that survives the checksum is either right
 * or an astronomical coincidence, which is not a claim any model's guess can
 * make.
 *
 * Returns a patch instead of writing, so the caller can apply it in the same
 * update as the rest of its OCR findings. A receipt whose merchant and company
 * arrive in two separate writes is briefly inconsistent, and the detail screen
 * is subscribed to both.
 */
export async function enrichReceiptCompany(
  input: CompanyEnrichmentInput,
): Promise<CompanyEnrichmentResult> {
  const cacheOnly = !input.autoLookup;
  const patch: Partial<Pick<Receipt, 'companyId' | 'merchant'>> = {};
  const filled: Array<'orgNumber' | 'companyName'> = [];

  let company: Company | null = null;
  let lookup: 'cached' | 'fetched' | null = null;
  let lookupReason: LookupFailure | null = null;
  let foundByName = false;
  /** How well the resolved company's name matches this receipt, 0..1. */
  let confidence = 0;

  if (input.orgNumber) {
    const outcome = await input.lookup.resolve(input.orgNumber.digits, {
      receiptText: input.receiptText,
      cacheOnly,
    });
    lookup = outcome.status === 'skipped' ? null : outcome.status;
    if (outcome.status === 'skipped') {
      lookupReason = outcome.reason;
    } else {
      company = outcome.company;
      confidence = matchCompanyName(company.name, input.receiptText).score;
    }
  }

  /*
   * The number is the better identifier, so the name search only runs when the
   * number did not produce a company the receipt agrees with. That covers three
   * failures with one rule: no number was legible, the number was legible but
   * unknown to the registry, and - the subtle one - the number passed its
   * checksum and resolved to a company whose name is nowhere on the paper,
   * which is what a misread digit looks like when it lands on another valid
   * number.
   */
  if (!cacheOnly && confidence < NAME_MATCH_THRESHOLD) {
    const byName = await input.lookup.resolveByName({ receiptText: input.receiptText });
    if (byName.status !== 'skipped' && byName.score > confidence) {
      company = byName.company;
      confidence = byName.score;
      lookup = byName.status;
      lookupReason = null;
      foundByName = true;
      // Adopt the number the search found. It is corroborated by the name
      // being on the receipt, which is more than the OCR reading had.
      patch.merchant = { ...input.receipt.merchant, orgNumber: company.orgNumber };
      filled.push('orgNumber');
    } else if (byName.status === 'skipped' && !company) {
      lookupReason = byName.reason;
    }
  }

  if (!company) return { ...NOTHING, lookup, lookupReason };

  patch.companyId = company.id;
  const merchant = patch.merchant ?? input.receipt.merchant;
  if (!merchant.name) {
    // Only ever fills a blank. A name the user typed is the more considered
    // one, and a silent overwrite is the worst outcome here.
    patch.merchant = { ...merchant, name: company.name };
    filled.push('companyName');
  }

  return { patch, company, lookup, lookupReason, foundByName, filled };
}
