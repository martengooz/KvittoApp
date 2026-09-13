/**
 * Swedish organisationsnummer: validation and recovery from OCR text.
 *
 * The format is `NNNNNN-NNNN`, and three properties make it unusually good to
 * hunt for in noisy OCR output:
 *
 * 1. The last digit is a Luhn check digit over the first nine, so a
 *    misrecognised digit is caught rather than silently accepted.
 * 2. Digits 3-4 — the "month" pair, by analogy with a personnummer — are
 *    always **at least 20**. That is precisely what distinguishes an
 *    organisationsnummer from a personnummer, and it rejects most random
 *    10-digit runs (phone numbers, card numbers, receipt ids).
 * 3. The first digit is the *gruppnummer* and only takes certain values, which
 *    also tells us the legal form.
 *
 * Together those three checks make a false positive very unlikely, which is
 * what lets the app look a number up against a paid API without wasting calls.
 *
 * Reference: https://sv.wikipedia.org/wiki/Organisationsnummer
 */

/** Legal form implied by the first digit of the number. */
export const GROUP_DIGIT_LEGAL_FORMS: Record<string, string> = {
  '1': 'Dödsbo',
  '2': 'Stat, region, kommun eller församling',
  '3': 'Utländskt företag med verksamhet i Sverige',
  '5': 'Aktiebolag',
  '6': 'Samfällighet',
  '7': 'Ekonomisk förening eller bostadsrättsförening',
  '8': 'Ideell förening eller stiftelse',
  '9': 'Handelsbolag eller kommanditbolag',
};

/** Digits that can legally start an organisationsnummer. */
const VALID_GROUP_DIGITS = new Set(Object.keys(GROUP_DIGIT_LEGAL_FORMS));

/**
 * Luhn (mod 10) check over a digit string.
 *
 * Doubles every second digit from the right, casts out nines, and requires the
 * total to be a multiple of ten.
 */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Computes the check digit for the first nine digits of an org number. */
export function luhnCheckDigit(firstNine: string): number | null {
  if (!/^\d{9}$/.test(firstNine)) return null;
  for (let candidate = 0; candidate <= 9; candidate += 1) {
    if (luhnValid(`${firstNine}${candidate}`)) return candidate;
  }
  return null;
}

/** Strips formatting and the optional `16` century prefix. Returns 10 digits or null. */
export function toTenDigits(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('16')) return digits.slice(2);
  if (digits.length === 10) return digits;
  return null;
}

export interface OrgNumberCheck {
  valid: boolean;
  /** The ten digits, unformatted, when the input could be read at all. */
  digits: string | null;
  /** `NNNNNN-NNNN`, when valid. */
  formatted: string | null;
  legalForm: string | null;
  /** Why it was rejected, for diagnostics rather than display. */
  reason?: 'length' | 'group-digit' | 'not-an-org-number' | 'checksum';
}

/**
 * Full validation. All three structural rules plus the checksum.
 *
 * `not-an-org-number` means digits 3-4 were below 20, which almost always
 * means the digits are a personnummer or an unrelated number — note that a
 * sole trader (enskild firma) legitimately trades under the owner's
 * personnummer, so such a receipt simply has no company to look up.
 */
export function checkOrgNumber(input: string): OrgNumberCheck {
  const digits = toTenDigits(input);
  if (!digits) return { valid: false, digits: null, formatted: null, legalForm: null, reason: 'length' };

  const group = digits[0]!;
  if (!VALID_GROUP_DIGITS.has(group)) {
    return { valid: false, digits, formatted: null, legalForm: null, reason: 'group-digit' };
  }
  if (Number(digits.slice(2, 4)) < 20) {
    return { valid: false, digits, formatted: null, legalForm: null, reason: 'not-an-org-number' };
  }
  if (!luhnValid(digits)) {
    return { valid: false, digits, formatted: null, legalForm: null, reason: 'checksum' };
  }

  return {
    valid: true,
    digits,
    formatted: `${digits.slice(0, 6)}-${digits.slice(6)}`,
    legalForm: GROUP_DIGIT_LEGAL_FORMS[group] ?? null,
  };
}

export function isValidOrgNumber(input: string): boolean {
  return checkOrgNumber(input).valid;
}

// --- recovery from OCR text ----------------------------------------------

/**
 * Labels Swedish receipts print before the number. A hit next to a candidate
 * is strong evidence, and is scored accordingly.
 */
const ORG_LABEL = /(org(?:anisations)?\s*\.?\s*(?:nr|nummer)|orgnr|momsreg\.?nr|vat\s*(?:no|nr)|f-?skatt)/i;

/**
 * Characters Tesseract most often confuses with digits.
 *
 * Only substitutions that are plausible for a *digit* position are listed; the
 * checksum then decides whether a repair was correct, so being generous here
 * costs nothing but a few extra candidates.
 */
const DIGIT_CONFUSIONS: Record<string, string[]> = {
  O: ['0'], o: ['0'], Q: ['0'], D: ['0'],
  I: ['1'], l: ['1'], L: ['1'], '|': ['1'], i: ['1'],
  Z: ['2'], z: ['2'],
  A: ['4'],
  S: ['5'], s: ['5'],
  G: ['6'], b: ['6'],
  T: ['7'],
  B: ['8'],
  g: ['9'], q: ['9'],
};

export interface OrgNumberCandidate {
  /** Ten digits, unformatted. */
  digits: string;
  formatted: string;
  legalForm: string | null;
  /** 0..1. Higher means more trustworthy. */
  confidence: number;
  /** The text as it appeared, before any repair. */
  raw: string;
  /** True when a character had to be corrected to a digit to make it parse. */
  repaired: boolean;
  /** True when an `Org.nr`-style label sat next to it. */
  labelled: boolean;
  /** Index in the source text, for highlighting. */
  index: number;
}

/**
 * Finds every plausible organisationsnummer in a block of OCR text.
 *
 * Returns validated candidates only, best first. A run of ten digits that
 * fails any structural rule is discarded rather than guessed at — with one
 * exception: if a *single* character in the run is a known OCR look-alike, the
 * repaired form is tried too, and kept only if it then passes the checksum.
 */
export function findOrgNumbers(text: string): OrgNumberCandidate[] {
  const candidates = new Map<string, OrgNumberCandidate>();

  // A loose sweep: 10-12 characters of digits and look-alikes, optionally
  // split by a hyphen, space or thin space in the usual 6+4 place.
  const pattern = /(?<![\d-])((?:[0-9OoQDIlL|iZzASsGbTBgq]){6}[\s .\-–—]?(?:[0-9OoQDIlL|iZzASsGbTBgq]){4,6})(?![\d])/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1]!;
    const index = match.index;
    const before = text.slice(Math.max(0, index - 40), index);
    const labelled = ORG_LABEL.test(before);

    for (const { digits, repaired } of repairCandidates(raw)) {
      const check = checkOrgNumber(digits);
      if (!check.valid || !check.digits || !check.formatted) continue;

      const confidence = scoreCandidate({ labelled, repaired, group: check.digits[0]! });
      const existing = candidates.get(check.digits);
      if (existing && existing.confidence >= confidence) continue;

      candidates.set(check.digits, {
        digits: check.digits,
        formatted: check.formatted,
        legalForm: check.legalForm,
        confidence,
        raw,
        repaired,
        labelled,
        index,
      });
    }
  }

  return [...candidates.values()].sort((a, b) => b.confidence - a.confidence);
}

/** The literal reading first, then single-character OCR repairs. */
function* repairCandidates(raw: string): Generator<{ digits: string; repaired: boolean }> {
  const compact = raw.replace(/[\s .\-–—]/g, '');
  yield { digits: compact, repaired: false };

  // Only single-character repairs. Allowing two or more would let the checksum
  // be satisfied by coincidence often enough to produce real false positives.
  for (let position = 0; position < compact.length; position += 1) {
    const character = compact[position]!;
    for (const replacement of DIGIT_CONFUSIONS[character] ?? []) {
      yield {
        digits: `${compact.slice(0, position)}${replacement}${compact.slice(position + 1)}`,
        repaired: true,
      };
    }
  }
}

/**
 * Legal forms that are structurally valid but almost never issue a receipt.
 *
 * `1` is an estate, `3` a foreign trader registered in Sweden, `6` a
 * samfällighet. All three exist; none of them runs a till.
 */
const RARE_GROUP_DIGITS = new Set(['1', '3', '6']);

function scoreCandidate(options: { labelled: boolean; repaired: boolean; group: string }): number {
  // A number that passed all three structural checks plus Luhn is already
  // unlikely to be an accident; the rest is corroboration.
  let score = 0.7;
  if (options.labelled) score += 0.25;
  // Most receipts come from limited companies, so a 5 is mildly corroborating.
  if (options.group === '5') score += 0.05;
  // The rare forms are the ones a misread leading digit lands on. A dödsbo,
  // a foreign trader or a samfällighet does not print till receipts often, so
  // when two candidates both pass Luhn the common form is the better bet.
  if (RARE_GROUP_DIGITS.has(options.group)) score -= 0.15;
  if (options.repaired) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}
