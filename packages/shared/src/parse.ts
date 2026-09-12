/**
 * Lenient parsers for the text an AI model reads off a Swedish receipt.
 *
 * Models are asked to return numbers, but in practice they hand back whatever
 * was printed on the paper: `1 234,50 kr`, `25,00-`, `(12,50)`. Everything here
 * is defensive and returns `null` rather than `NaN` when it cannot be sure.
 */

/** Space characters Swedish receipts use as a thousands separator. */
const SPACE_CHARS = /[\s   ]/g;
/** Minus signs that are not ASCII hyphen. */
const MINUS_CHARS = /[−–—]/g;

const CURRENCY_WORDS =
  /\b(kr|kronor|sek|eur|euro|usd|nok|dkk|inkl\.?|exkl\.?|moms|st|kg|hg|g|l|dl|cl|m|förp)\b/gi;

/** Rounds to 2 decimals without the usual binary-float dust (`1.005 -> 1.01`). */
export function roundMoney(value: number): number {
  return roundTo(value, 2);
}

/** Rounds to `decimals` places, compensating for binary-float representation. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export interface ParseAmountOptions {
  /**
   * Whether a single `,`/`.` followed by exactly three digits may mean
   * thousands (`1,234` → 1234). True for money, false for quantities, where
   * three decimals are ordinary (`0,412 kg`).
   */
  allowGrouping?: boolean;
  /**
   * Decimal places to round to. Two for money; quantities need three
   * (`0,412 kg`).
   */
  maxDecimals?: number;
}

/**
 * Parses a money amount printed in Swedish (or English) conventions.
 *
 * Handles thousands spaces/dots, comma decimals, currency suffixes, the Swedish
 * `:-` "and no öre" suffix, leading and *trailing* minus signs (cash registers
 * print `25,00-` for a credit), and parenthesised negatives. Returns `null`
 * when the input holds no digits.
 */
export function parseAmount(input: unknown, options: ParseAmountOptions = {}): number | null {
  const maxDecimals = options.maxDecimals ?? 2;
  if (typeof input === 'number') return Number.isFinite(input) ? roundTo(input, maxDecimals) : null;
  if (typeof input !== 'string') return null;

  const allowGrouping = options.allowGrouping ?? true;
  let text = input.replace(MINUS_CHARS, '-').replace(CURRENCY_WORDS, ' ').trim();
  if (!text) return null;

  // `12:-` and `12:00` are Swedish shorthand for "12 kronor even". Strip the
  // suffix before the trailing-minus check below reads that dash as a sign.
  text = text.replace(/:\s*-\s*$/, '').replace(/:\s*$/, '').trim();
  if (!text) return null;

  let negative = false;
  // Accounting style: (12,50) means -12.50
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  // Registers commonly print the sign after the number.
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text.startsWith('+')) text = text.slice(1);

  text = text.replace(SPACE_CHARS, '');
  // Drop anything that is not a digit or a separator (stray `kr:-`, `:-`, `*`).
  text = text.replace(/[^\d.,]/g, '');
  if (!/\d/.test(text)) return null;

  const decimalSeparator = pickDecimalSeparator(text, allowGrouping);
  if (decimalSeparator) {
    const thousands = decimalSeparator === ',' ? '.' : ',';
    text = text.split(thousands).join('');
    text = text.replace(decimalSeparator, '.');
  } else {
    text = text.replace(/[.,]/g, '');
  }

  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return null;
  return roundTo(negative ? -value : value, maxDecimals);
}

/**
 * Decides which of `.` / `,` acts as the decimal point, or `null` when both are
 * grouping separators (`1.234.567`).
 */
function pickDecimalSeparator(text: string, allowGrouping: boolean): '.' | ',' | null {
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma === -1 && lastDot === -1) return null;

  // Both present: whichever comes last is the decimal point (`1.234,50` / `1,234.50`).
  if (lastComma !== -1 && lastDot !== -1) return lastComma > lastDot ? ',' : '.';

  const separator: '.' | ',' = lastComma !== -1 ? ',' : '.';
  const index = lastComma !== -1 ? lastComma : lastDot;
  const decimals = text.length - index - 1;
  const occurrences = text.split(separator).length - 1;

  // Grouped forms like `1,234,567` are unambiguous.
  if (occurrences > 1) return null;
  // `1,234` with exactly one separator and three trailing digits is ambiguous.
  // Read it as thousands only for money, and only when the leading group looks
  // like one — `0,412` is a quantity, never 412.
  if (allowGrouping && decimals === 3 && /^[1-9]\d{0,2}[.,]\d{3}$/.test(text)) return null;
  return separator;
}

const UNIT_ALIASES: Record<string, string> = {
  st: 'st',
  styck: 'st',
  stk: 'st',
  x: 'st',
  kg: 'kg',
  kilo: 'kg',
  hg: 'hg',
  g: 'g',
  gram: 'g',
  l: 'l',
  liter: 'l',
  dl: 'dl',
  cl: 'cl',
  m: 'm',
  meter: 'm',
  förp: 'förp',
  frp: 'förp',
  pkt: 'förp',
  paket: 'förp',
};

export type ParsedQuantity = { quantity: number; unit: string };

/**
 * Parses `2 st`, `0,412 kg`, `1,5 l` or a bare number into a quantity and unit.
 * Falls back to `1 st`, which is what an unlabelled receipt line means.
 */
export function parseQuantity(input: unknown): ParsedQuantity {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { quantity: input, unit: 'st' };
  }
  if (typeof input !== 'string') return { quantity: 1, unit: 'st' };

  const text = input.trim().toLowerCase();
  if (!text) return { quantity: 1, unit: 'st' };

  const match = /^([\d\s .,]+)\s*([a-zåäö]*)/.exec(text);
  if (!match) return { quantity: 1, unit: 'st' };

  const amount = parseAmount(match[1] ?? '', { allowGrouping: false, maxDecimals: 3 });
  const rawUnit = (match[2] ?? '').replace(/\./g, '');
  const unit = UNIT_ALIASES[rawUnit] ?? (rawUnit ? 'other' : 'st');
  return { quantity: amount === null || amount === 0 ? 1 : Math.abs(amount), unit };
}

const SWEDISH_MONTHS: Record<string, number> = {
  jan: 1, januari: 1,
  feb: 2, februari: 2,
  mar: 3, mars: 3,
  apr: 4, april: 4,
  maj: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  aug: 8, augusti: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Parses a receipt date into a **local wall-clock** ISO string with no timezone
 * suffix, e.g. `2024-03-15T14:22:00` or `2024-03-15`.
 *
 * Receipts print local time with no offset, so converting to UTC would require
 * guessing a timezone and would shift late-evening purchases to the wrong day.
 * Keeping the naive local string sidesteps that, and still sorts correctly
 * lexicographically.
 */
export function parseLocalDateTime(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  const time = extractTime(text);
  const date = extractDate(text);
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

function extractDate(text: string): string | null {
  // 2024-03-15 / 2024/03/15 / 20240315
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (m) return buildDate(+m[1]!, +m[2]!, +m[3]!);

  // 15/3-24, 15/3 2024, 15.03.2024, 15-03-24
  m = /(?<![\d:])(\d{1,2})[-/.](\d{1,2})[-/. ]+(?:-\s*)?(\d{2,4})(?![\d:])/.exec(text);
  if (m) return buildDate(expandYear(+m[3]!), +m[2]!, +m[1]!);

  // 15 mars 2024 / 15 mars
  m = /(\d{1,2})\.?\s+([a-zåäö]{3,9})\.?\s*(\d{4})?/i.exec(text);
  if (m) {
    const month = SWEDISH_MONTHS[m[2]!.toLowerCase()];
    if (month) {
      const year = m[3] ? +m[3] : new Date().getFullYear();
      return buildDate(year, month, +m[1]!);
    }
  }

  // Compact YYMMDD, as printed in the header of many kassa slips.
  m = /(?<!\d)(\d{6})(?!\d)/.exec(text);
  if (m) {
    const digits = m[1]!;
    return buildDate(expandYear(+digits.slice(0, 2)), +digits.slice(2, 4), +digits.slice(4, 6));
  }
  return null;
}

function extractTime(text: string): string | null {
  const m = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?:[:.]([0-5]\d))?(?!\d)/.exec(text);
  if (!m) return null;
  // A bare `15.03` inside a date is not a time; require an explicit colon or seconds.
  if (!text.includes(':') && !m[3]) return null;
  return `${pad(+m[1]!)}:${m[2]}:${m[3] ? m[3] : '00'}`;
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  // Two-digit years on receipts are always recent; 70 keeps 1970s imports sane.
  return year >= 70 ? 1900 + year : 2000 + year;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1970 || year > 2200) return null;
  // Reject impossible days (e.g. 31 February) by round-tripping through Date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Normalises a Swedish organisationsnummer to `NNNNNN-NNNN`, or `null`. */
export function normalizeOrgNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  // 10 digits, or 12 with the `16` century prefix companies sometimes print.
  const core = digits.length === 12 && digits.startsWith('16') ? digits.slice(2) : digits;
  if (core.length !== 10) return null;
  return `${core.slice(0, 6)}-${core.slice(6)}`;
}

/** Normalises a VAT number to `SE############`, or `null`. */
export function normalizeVatNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})?(\d{10,12})(\d{2})?$/.exec(cleaned);
  if (!m) return null;
  const country = m[1] ?? 'SE';
  const digits = cleaned.replace(/^[A-Z]{2}/, '');
  if (country === 'SE' && digits.length === 10) return `SE${digits}01`;
  if (digits.length < 8) return null;
  return `${country}${digits}`;
}

/**
 * Search key for a product name: lowercased, accent-preserving (Swedish `å ä ö`
 * are distinct letters, not accents), punctuation collapsed to single spaces.
 */
export function normalizeSearchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Splits a search query into terms, honouring "quoted phrases". */
export function tokenizeQuery(query: string): string[] {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const term = normalizeSearchName(match[1] ?? match[2] ?? '');
    if (term) terms.push(term);
  }
  return terms;
}
