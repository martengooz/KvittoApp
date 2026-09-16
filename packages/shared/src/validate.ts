/**
 * Arithmetic sanity checks on a parsed receipt.
 *
 * These never block saving — a receipt the model read imperfectly is still
 * worth keeping. They surface as review prompts so the user knows which
 * receipts deserve a second look.
 */

import { localDateToday } from './format.js';
import { roundMoney } from './parse.js';
import type { NormalizedExtraction } from './extraction.js';

/** Swedish VAT rates. Anything else is worth flagging. */
export const SWEDISH_VAT_RATES = [0, 6, 12, 25] as const;

/** Tolerance in kronor before a mismatch is reported. Covers öre rounding. */
const AMOUNT_TOLERANCE = 0.51;

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface ValidationIssue {
  /** Stable identifier so the UI can dedupe and link to the right field. */
  code: string;
  severity: IssueSeverity;
  message: string;
  /** Dot-path of the offending field, when there is a single one. */
  field?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** Sum of all non-discount, non-deposit line totals. */
  itemsTotal: number;
  /** Sum of the line items including discount and deposit rows. */
  linesTotal: number;
  /** Difference between the receipt total and what the lines add up to. */
  discrepancy: number | null;
  /** True when nothing worse than `info` was found. */
  ok: boolean;
}

export function validateExtraction(extraction: NormalizedExtraction): ValidationReport {
  const issues: ValidationIssue[] = [];

  const itemsTotal = roundMoney(
    extraction.items
      .filter((item) => !item.isDiscount && !item.isDeposit)
      .reduce((sum, item) => sum + item.totalPrice, 0),
  );
  const linesTotal = roundMoney(
    extraction.items.reduce((sum, item) => sum + item.totalPrice, 0),
  );

  if (!extraction.merchant.name) {
    issues.push({
      code: 'merchant-missing',
      severity: 'warning',
      message: 'No store name was found.',
      field: 'merchant.name',
    });
  }

  if (!extraction.purchasedAt) {
    issues.push({
      code: 'date-missing',
      severity: 'warning',
      message: 'No purchase date was found.',
      field: 'purchasedAt',
    });
  } else if (extraction.purchasedAt.slice(0, 10) > localDateToday()) {
    issues.push({
      code: 'date-future',
      severity: 'warning',
      message: 'The purchase date is in the future.',
      field: 'purchasedAt',
    });
  }

  if (extraction.total === null) {
    issues.push({
      code: 'total-missing',
      severity: 'error',
      message: 'No total was found.',
      field: 'total',
    });
  } else if (extraction.total < 0) {
    issues.push({
      code: 'total-negative',
      severity: 'info',
      message: 'The total is negative — this looks like a refund.',
      field: 'total',
    });
  }

  if (extraction.items.length === 0) {
    issues.push({
      code: 'items-missing',
      severity: 'warning',
      message: 'No line items were read from this receipt.',
      field: 'items',
    });
  }

  let discrepancy: number | null = null;
  if (extraction.total !== null && extraction.items.length > 0) {
    const expected = roundMoney(
      linesTotal + (extraction.roundingAmount ?? 0) - (extraction.discountTotal ?? 0),
    );
    discrepancy = roundMoney(extraction.total - expected);
    if (Math.abs(discrepancy) > AMOUNT_TOLERANCE) {
      issues.push({
        code: 'total-mismatch',
        severity: 'warning',
        message:
          `The line items add up to ${expected.toFixed(2)} but the total says ` +
          `${extraction.total.toFixed(2)} (off by ${discrepancy.toFixed(2)}).`,
        field: 'total',
      });
    }
  }

  if (extraction.vatLines.length > 0 && extraction.total !== null) {
    const grossSum = roundMoney(
      extraction.vatLines.reduce((sum, line) => sum + (line.gross ?? 0), 0),
    );
    if (grossSum > 0 && Math.abs(grossSum - extraction.total) > AMOUNT_TOLERANCE) {
      issues.push({
        code: 'vat-mismatch',
        severity: 'warning',
        message:
          `The VAT summary totals ${grossSum.toFixed(2)}, which does not match the ` +
          `receipt total of ${extraction.total.toFixed(2)}.`,
        field: 'vatLines',
      });
    }
  }

  for (const line of extraction.vatLines) {
    if (!(SWEDISH_VAT_RATES as readonly number[]).includes(line.rate)) {
      issues.push({
        code: 'vat-rate-unusual',
        severity: 'info',
        message: `${line.rate} % is not a standard Swedish VAT rate.`,
        field: 'vatLines',
      });
    }
    if (line.net !== null && line.vat !== null && line.rate > 0) {
      const expectedVat = roundMoney((line.net * line.rate) / 100);
      if (Math.abs(expectedVat - line.vat) > AMOUNT_TOLERANCE) {
        issues.push({
          code: 'vat-line-mismatch',
          severity: 'info',
          message:
            `${line.rate} % of ${line.net.toFixed(2)} is ${expectedVat.toFixed(2)}, ` +
            `but the receipt says ${line.vat.toFixed(2)}.`,
          field: 'vatLines',
        });
      }
    }
  }

  return {
    issues,
    itemsTotal,
    linesTotal,
    discrepancy,
    ok: issues.every((issue) => issue.severity === 'info'),
  };
}


/**
 * Whether one reading of a receipt is a better account of it than another.
 *
 * Used to decide whether a correcting second pass earned its place. Errors are
 * compared before warnings rather than weighted against them, because they are
 * different in kind: a missing total makes the receipt unusable, while a VAT
 * line a krona out is a detail. Only when both counts tie does the size of the
 * arithmetic gap break it — so a pass that narrows a 40 kr discrepancy to 60
 * öre counts as progress even though the warning itself survives.
 *
 * Deliberately strict: equal is not better. A correcting pass that merely
 * trades one problem for another leaves the original reading in place, because
 * two readings that are equally wrong are not an improvement, and the first one
 * at least was not produced by a prompt that had been told to change something.
 */
export function isBetterReading(next: ValidationReport, previous: ValidationReport): boolean {
  const count = (report: ValidationReport, severity: IssueSeverity): number =>
    report.issues.filter((issue) => issue.severity === severity).length;

  const nextErrors = count(next, 'error');
  const previousErrors = count(previous, 'error');
  if (nextErrors !== previousErrors) return nextErrors < previousErrors;

  const nextWarnings = count(next, 'warning');
  const previousWarnings = count(previous, 'warning');
  if (nextWarnings !== previousWarnings) return nextWarnings < previousWarnings;

  return Math.abs(next.discrepancy ?? 0) < Math.abs(previous.discrepancy ?? 0);
}
