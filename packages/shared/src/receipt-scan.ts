/**
 * Reading structured facts out of raw OCR text.
 *
 * This is the deterministic, offline counterpart to the AI extraction: it does
 * far less, but it needs no API key, no network and no model, and what it does
 * find is checksum-verified rather than generated. Its results are used to
 * cross-check the model — and to stand in for it when no provider is set up.
 */

import { toLocalIsoDate } from './format.js';
import { stripAccents } from './fuzzy.js';
import { findOrgNumbers, type OrgNumberCandidate } from './orgnumber.js';
import { parseLocalDateTime } from './parse.js';

/** Labels Swedish receipts print next to the purchase date. */
const DATE_LABEL = /(datum|dat\b|köpdatum|kopdatum|inköpsdatum|tid|date)/i;

/**
 * Labels that mark a date as something other than the purchase date.
 *
 * Tested against accent-stripped text, because OCR loses å/ä/ö constantly —
 * `Bäst före` comes back as `Bast fore` and would otherwise sail through.
 */
const NON_PURCHASE_LABEL =
  /(bast\s*fore|utgar|giltig|galler|oppet\s*kop|retur|garanti|period|fodelse|forfaller|utgangs)/i;

/**
 * Date shapes worth testing, loosest last. Each is handed to
 * `parseLocalDateTime`, which does the real validation — including rejecting
 * impossible days — so a generous pattern here costs nothing.
 */
const DATE_PATTERNS: RegExp[] = [
  // 2024-03-15 14:22[:33]
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)?\b/g,
  // 15/3-24, 15.03.2024, 15-03-24
  /\b\d{1,2}[-/.]\d{1,2}[-/. ]{1,3}-?\s?\d{2,4}\b/g,
  // 15 mars 2024
  /\b\d{1,2}\.?\s+[a-zA-ZåäöÅÄÖ]{3,9}\.?\s*\d{2,4}\b/g,
  // 26 07 26 12:53 — space-separated, as BAUHAUS prints it
  /\b\d{2}\s\d{2}\s\d{2}\s+\d{1,2}[:.]\d{2}\b/g,
];

export interface DateCandidate {
  /** Naive local ISO string, `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`. */
  value: string;
  /** The text it was read from. */
  raw: string;
  /** 0..1. */
  confidence: number;
  index: number;
}

export interface ScanFindings {
  orgNumbers: OrgNumberCandidate[];
  dates: DateCandidate[];
  /** Best organisation number, or null. */
  orgNumber: OrgNumberCandidate | null;
  /** Best purchase date, or null. */
  purchasedAt: DateCandidate | null;
}

/**
 * Pulls organisation numbers and dates out of OCR text.
 *
 * Dates are scored rather than taken first-found: a receipt carries several
 * (purchase, best-before, open-purchase deadline, card expiry), and the one
 * that matters is usually near a `Datum` label, near the top, and not in the
 * future.
 */
export function scanReceiptText(text: string, options: { today?: Date } = {}): ScanFindings {
  const orgNumbers = findOrgNumbers(text);
  const dates = findDates(text, options.today ?? new Date());

  return {
    orgNumbers,
    dates,
    orgNumber: orgNumbers[0] ?? null,
    purchasedAt: dates[0] ?? null,
  };
}

function findDates(text: string, today: Date): DateCandidate[] {
  const found = new Map<string, DateCandidate>();
  const todayIso = toLocalIsoDate(today);

  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      const value = parseLocalDateTime(raw);
      if (!value) continue;

      const index = match.index;
      // Only the line the date sits on. A wider window reaches onto the
      // neighbouring line and lets its label decide this date's fate — which
      // made `Giltig 2026-12-31` on one line disqualify the purchase date on
      // the next.
      const context = stripAccents(lineAround(text, index));

      // A best-before or warranty date is a date, just not this one.
      if (NON_PURCHASE_LABEL.test(context)) continue;

      const confidence = scoreDate({
        value,
        labelled: DATE_LABEL.test(context),
        hasTime: value.includes('T'),
        position: index / Math.max(1, text.length),
        todayIso,
      });

      const existing = found.get(value);
      if (existing && existing.confidence >= confidence) continue;
      found.set(value, { value, raw, confidence, index });
    }
  }

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

function scoreDate(options: {
  value: string;
  labelled: boolean;
  hasTime: boolean;
  position: number;
  todayIso: string;
}): number {
  let score = 0.5;

  if (options.labelled) score += 0.2;
  // A time of day almost always belongs to the transaction itself.
  if (options.hasTime) score += 0.15;

  const day = options.value.slice(0, 10);
  if (day > options.todayIso) {
    // Future dates are card expiries and warranty ends, not purchases.
    score -= 0.45;
  } else if (withinDays(day, options.todayIso, 400)) {
    // Receipts are usually recent; this separates the purchase date from a
    // printed copyright year or an unrelated old date.
    score += 0.15;
  }

  return Math.max(0, Math.min(1, score));
}

function withinDays(day: string, todayIso: string, days: number): boolean {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return (b - a) / 86_400_000 <= days;
}

/** The whole line containing `index`. */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

