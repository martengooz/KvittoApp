/**
 * The OCR enrichment pass: read the receipt, then verify what it says.
 *
 * This runs entirely on the device and entirely without an AI model. It exists
 * for two reasons the model cannot serve:
 *
 * 1. **It is checked, not generated.** An organisation number that survives the
 *    Luhn checksum and the structural rules is either right or an astronomical
 *    coincidence; a model's guess at one is neither.
 * 2. **It works with no key and no network.** A user who has configured nothing
 *    still gets a merchant, a date and — once the registry has been asked once —
 *    a company.
 *
 * The registry lookup is the only part that touches the network, and it is
 * skipped whenever the company is already stored.
 */

import {
  matchCompanyName,
  scanReceiptText,
  NAME_MATCH_THRESHOLD,
  type Company,
  type ID,
  type OcrInfo,
  type Receipt,
} from '@kvitto/shared';

import { getSettings } from '../core/settings.js';
import { getBlob } from '../db/blobs.js';
import { db } from '../db/db.js';
import { resolveCompany, resolveCompanyByName, type ResolveOutcome } from '../company/lookup.js';
import type { LookupFailure } from '../api/apiverket.js';
import { updateReceipt } from '../db/repo.js';
import { ocrClient } from './client.js';
import { prepareForOcr } from './prepare.js';

export interface EnrichOutcome {
  ok: boolean;
  /** Why nothing happened, in Swedish, for a toast or an inline note. */
  reason: string | null;
  ocr: OcrInfo | null;
  company: Company | null;
  /** What the company lookup did, when it ran at all. */
  lookup: ResolveOutcome['status'] | null;
  /** Why the lookup was skipped, when it was. */
  lookupReason: LookupFailure | null;
  /** True when the company was found from the shop's name, not its number. */
  foundByName: boolean;
  /** Fields this pass filled in that were previously empty. */
  filled: string[];
}

const NOTHING: EnrichOutcome = {
  ok: false,
  reason: null,
  ocr: null,
  company: null,
  lookup: null,
  lookupReason: null,
  foundByName: false,
  filled: [],
};

/**
 * Reads `image`, files the findings on the receipt and links its company.
 *
 * `image` should be the *original* capture wherever one is still to hand — see
 * `prepare.ts` for why the enhanced scan is the worse input. Nothing derived
 * from it is stored; the working copy lives only for the length of this call.
 */
export async function enrichFromImage(receiptId: ID, image: Blob): Promise<EnrichOutcome> {
  const result = await ocrClient.recognize(await prepareForOcr(image));
  if (!result || result.text.trim().length < 8) {
    return { ...NOTHING, reason: 'Ingen text kunde läsas ur bilden.' };
  }

  const findings = scanReceiptText(result.text);
  const ocr: OcrInfo = {
    text: result.text,
    confidence: Math.round(result.confidence),
    engine: 'tesseract',
    at: Date.now(),
    durationMs: result.durationMs,
    orgNumbers: findings.orgNumbers.map((candidate) => ({
      value: candidate.formatted,
      confidence: candidate.confidence,
      repaired: candidate.repaired,
    })),
    dates: findings.dates.map((candidate) => ({
      value: candidate.value,
      confidence: candidate.confidence,
    })),
  };

  const receipt = await db.receipts.get(receiptId);
  if (!receipt) return { ...NOTHING, ocr, reason: 'Kvittot finns inte längre.' };

  const patch: Partial<Receipt> = { ocr };
  const filled: string[] = [];

  // Only ever fills a blank. A value the user typed or the model extracted is
  // the more considered one, and a silent overwrite is the worst outcome here.
  if (!receipt.purchasedAt && findings.purchasedAt) {
    patch.purchasedAt = findings.purchasedAt.value;
    filled.push('datum');
  }

  let company: Company | null = null;
  let lookup: ResolveOutcome['status'] | null = null;
  let lookupReason: LookupFailure | null = null;
  let foundByName = false;
  /** How well the resolved company's name matches this receipt, 0..1. */
  let confidence = 0;

  const cacheOnly = !getSettings().company.autoLookup;
  const best = findings.orgNumber;

  if (best) {
    if (!receipt.merchant.orgNumber) {
      patch.merchant = { ...receipt.merchant, orgNumber: best.formatted };
      filled.push('organisationsnummer');
    }

    // A company already stored is free to reuse, so the auto-lookup switch
    // only gates the network call, never the cache hit.
    const outcome = await resolveCompany(best.digits, { receiptText: result.text, cacheOnly });
    lookup = outcome.status;
    if (outcome.status === 'skipped') lookupReason = outcome.reason;
    else {
      company = outcome.company;
      confidence = matchCompanyName(company.name, result.text).score;
    }
  }

  /**
   * The number is the better identifier, so the name search only runs when the
   * number did not produce a company the receipt agrees with. That covers three
   * distinct failures with one rule: no number was legible, the number was
   * legible but unknown to the registry, and — the subtle one — the number
   * passed its checksum and resolved to a company whose name is nowhere on the
   * paper, which is what a misread digit looks like when it happens to land on
   * another valid number.
   */
  if (!cacheOnly && confidence < NAME_MATCH_THRESHOLD) {
    const byName = await resolveCompanyByName({ receiptText: result.text });
    if (byName.status !== 'skipped' && byName.score > confidence) {
      company = byName.company;
      confidence = byName.score;
      lookup = byName.status;
      lookupReason = null;
      foundByName = true;
      // Adopt the number the search found. It is corroborated by the name being
      // on the receipt, which is more than the OCR reading had going for it.
      patch.merchant = { ...(patch.merchant ?? receipt.merchant), orgNumber: company.orgNumber };
      if (!filled.includes('organisationsnummer')) filled.push('organisationsnummer');
    } else if (byName.status === 'skipped' && !company) {
      lookupReason = byName.reason;
    }
  }

  if (company) {
    patch.companyId = company.id;
    const merchant = patch.merchant ?? receipt.merchant;
    if (!merchant.name) {
      patch.merchant = { ...merchant, name: company.name };
      filled.push('företagsnamn');
    }
  }

  await updateReceipt(receiptId, patch);
  return { ok: true, reason: null, ocr, company, lookup, lookupReason, foundByName, filled };
}

/**
 * Re-runs enrichment from whatever image the receipt still has.
 *
 * Used by the "read again" action, and by any receipt saved before OCR existed.
 * Prefers the untouched original when the user chose to keep it; otherwise the
 * processed scan, which reads less well but is always there.
 */
export async function enrichReceipt(receiptId: ID): Promise<EnrichOutcome> {
  const receipt = await db.receipts.get(receiptId);
  if (!receipt) return { ...NOTHING, reason: 'Kvittot finns inte längre.' };

  const stored = (await getBlob(receipt.originalImageId)) ?? (await getBlob(receipt.imageId));
  if (!stored) return { ...NOTHING, reason: 'Kvittot har ingen bild att läsa.' };

  return enrichFromImage(receiptId, stored.data);
}

/**
 * Re-checks a stored company's name against a receipt's OCR text.
 *
 * Cheap and offline — no lookup, just the fuzzy comparison — so the detail view
 * can show a live verdict for a company that was first matched from a different
 * receipt.
 */
export function verifyCompanyName(company: Company, ocr: OcrInfo | null): {
  score: number;
  confirmed: boolean;
  matched: string[];
} | null {
  if (!ocr?.text) return null;
  const match = matchCompanyName(company.name, ocr.text);
  return { score: match.score, confirmed: match.confirmed, matched: match.matchedTokens };
}
