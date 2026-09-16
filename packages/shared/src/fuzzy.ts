/**
 * Fuzzy matching of a registered company name against OCR text.
 *
 * The org number is checksum-verified, so a lookup is very likely correct —
 * but "very likely" is not "certain", and a receipt filed under the wrong
 * company is worse than one filed under none. This module is the corroborating
 * check: does the name the registry returned actually appear on the paper?
 *
 * Three things make a naive string comparison useless here:
 *
 * - **Legal suffixes.** The registry says `AB Volvo (publ)`; the receipt says
 *   `VOLVO`. Neither is wrong.
 * - **Case and spacing.** Receipts shout in capitals and pad with spaces.
 * - **OCR damage.** `IKEA` becomes `IREA`, `MJÖLK` becomes `MJOLK`, `rn`
 *   becomes `m`. Edit distance alone treats `IREA` and `AREA` as equally close
 *   to `IKEA`; weighting known confusions cheaply does not.
 */

/** Legal-form suffixes and prefixes that carry no identifying information. */
const LEGAL_TOKENS = new Set([
  'ab', 'aktiebolag', 'publ', 'hb', 'kb', 'handelsbolag', 'kommanditbolag',
  'ekonomisk', 'forening', 'ek', 'for', 'brf', 'bostadsrattsforening',
  'stiftelse', 'ideell', 'i', 'och', 'and', 'the', 'sweden', 'sverige',
  'group', 'holding', 'nordic', 'scandinavia', 'ltd', 'inc', 'as', 'oy',
]);

/**
 * Character pairs Tesseract routinely swaps. Substituting one for the other
 * costs less than an unrelated edit.
 */
const CONFUSABLE: [string, string][] = [
  ['0', 'o'], ['1', 'i'], ['1', 'l'], ['i', 'l'], ['5', 's'], ['8', 'b'],
  ['6', 'g'], ['2', 'z'], ['9', 'g'], ['k', 'r'], ['c', 'e'], ['u', 'v'],
  ['n', 'm'], ['h', 'n'], ['d', 'o'], ['q', 'g'], ['t', 'f'], ['y', 'v'],
];

const CONFUSION_COST = new Map<string, number>();
for (const [a, b] of CONFUSABLE) {
  CONFUSION_COST.set(`${a}|${b}`, 0.4);
  CONFUSION_COST.set(`${b}|${a}`, 0.4);
}

/**
 * Folds a string for comparison: lowercase, accents removed, everything but
 * letters and digits collapsed to single spaces.
 *
 * Accents go because OCR drops them constantly (`MJÖLK` → `MJOLK`) — this is
 * the one place in the app where Swedish å/ä/ö are *not* treated as distinct
 * letters, precisely because the scanner cannot be trusted to see the dots.
 */
export function foldForMatching(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Folded tokens with legal-form noise removed. Falls back to all tokens. */
export function significantTokens(name: string): string[] {
  const tokens = foldForMatching(name).split(' ').filter(Boolean);
  const meaningful = tokens.filter((token) => !LEGAL_TOKENS.has(token) && token.length > 1);
  // A company genuinely called "AB" would otherwise reduce to nothing.
  return meaningful.length > 0 ? meaningful : tokens;
}

/**
 * Levenshtein distance where known OCR confusions cost less than a full edit.
 *
 * Uses two rolling rows rather than a full matrix: the inputs here are company
 * names and OCR windows, so this runs thousands of times per scan.
 */
export function ocrAwareDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Float64Array(b.length + 1);
  let current = new Float64Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const charA = a[i - 1]!;
    for (let j = 1; j <= b.length; j += 1) {
      const charB = b[j - 1]!;
      const substitution =
        charA === charB ? 0 : (CONFUSION_COST.get(`${charA}|${charB}`) ?? 1);
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Distance normalised to a 0..1 similarity. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - ocrAwareDistance(a, b) / longest);
}

export interface NameMatch {
  /** 0..1. */
  score: number;
  /** The text from the receipt that matched best. */
  matched: string | null;
  /** Which significant tokens of the registered name were found. */
  matchedTokens: string[];
  missingTokens: string[];
  /** True once the score clears the accept threshold. */
  confirmed: boolean;
}

/** Score at or above which a name is treated as confirmed on the receipt. */
export const NAME_MATCH_THRESHOLD = 0.62;

/**
 * How much an unmatched token still counts against the score.
 *
 * A *registered* name is routinely longer than the name a shop prints on its
 * receipts — `IKEA Svenska Försäljnings AB` sells you things as `IKEA`. Scoring
 * absent tokens at full weight makes the registry's own verbosity look like
 * evidence of a mismatch, which is backwards.
 */
const MISSING_TOKEN_WEIGHT = 0.35;

/**
 * Extra weight for the leading significant token.
 *
 * Swedish company names lead with the brand and trail into qualifiers
 * (`Biltema Sweden AB`, `IKEA Svenska Försäljnings AB`), so the first token is
 * both the most identifying and the one most likely to be printed. Without
 * this, a receipt saying only `Ikea` scores the same as one saying only
 * `Svenska`, which is plainly wrong.
 */
const FIRST_TOKEN_WEIGHT = 2.5;

/** Per-token score at or above which a token counts as present. */
const TOKEN_PRESENT = 0.75;

/**
 * Looks for `companyName` inside `receiptText`.
 *
 * Scores each significant token of the registered name against a sliding
 * window of same-length substrings of the receipt, then combines the per-token
 * results weighted by token length — a match on `volvo` should count for far
 * more than a match on `ab`.
 *
 * Matching per token rather than on the whole string is what makes
 * `AB Volvo (publ)` match a receipt that only says `VOLVO`: the missing
 * tokens simply do not contribute, instead of dragging a whole-string edit
 * distance down.
 */
export function matchCompanyName(companyName: string, receiptText: string): NameMatch {
  const tokens = significantTokens(companyName);
  const haystack = foldForMatching(receiptText);

  if (tokens.length === 0 || haystack.length === 0) {
    return { score: 0, matched: null, matchedTokens: [], missingTokens: tokens, confirmed: false };
  }

  const words = haystack.split(' ').filter(Boolean);
  const matchedTokens: string[] = [];
  const missingTokens: string[] = [];
  let weighted = 0;
  let totalWeight = 0;
  let matchedWeight = 0;
  let missingWeight = 0;
  let bestSnippet: { text: string; score: number } | null = null;

  // A plain loop rather than `forEach`: assignments inside a callback defeat
  // TypeScript's control-flow analysis, which then narrows `bestSnippet` to
  // `null` for the code after the loop.
  for (const [position, token] of tokens.entries()) {
    // Length as a proxy for how identifying a token is, with the leading
    // token boosted as the likely brand.
    const weight = token.length * (position === 0 ? FIRST_TOKEN_WEIGHT : 1);
    totalWeight += weight;

    const best = bestTokenMatch(token, words, haystack);
    weighted += best.score * weight;

    if (best.score >= TOKEN_PRESENT) {
      matchedTokens.push(token);
      matchedWeight += weight;
    } else {
      missingTokens.push(token);
      missingWeight += weight;
    }

    if (!bestSnippet || best.score > bestSnippet.score) {
      bestSnippet = { text: best.snippet, score: best.score };
    }
  }

  /*
   * Two scoring modes, and the split matters.
   *
   * When at least one token is genuinely present, absent tokens are discounted
   * so a brand-only receipt still confirms its longer registered name.
   *
   * When *nothing* matched, that discount is applied strictly — shrinking the
   * denominator would otherwise inflate a total mismatch into a high score,
   * confidently filing a Biltema receipt under an ICA company.
   */
  const denominator =
    matchedTokens.length === 0 ? totalWeight : matchedWeight + MISSING_TOKEN_WEIGHT * missingWeight;
  const score = denominator === 0 ? 0 : Math.min(1, weighted / denominator);

  return {
    score: Math.round(score * 1000) / 1000,
    matched: bestSnippet?.text ?? null,
    matchedTokens,
    missingTokens,
    confirmed: score >= NAME_MATCH_THRESHOLD,
  };
}

/**
 * Best match for one token: first against whole words, then against a sliding
 * character window, which catches tokens the OCR ran together with a neighbour.
 */
function bestTokenMatch(
  token: string,
  words: string[],
  haystack: string,
): { score: number; snippet: string } {
  let best = { score: 0, snippet: '' };

  for (const word of words) {
    // Skip words whose length makes a good score arithmetically impossible.
    if (Math.abs(word.length - token.length) > token.length * 0.6) continue;
    const score = similarity(token, word);
    if (score > best.score) best = { score, snippet: word };
    if (best.score === 1) return best;
  }

  // A sliding window costs more, so only run it when word matching was weak.
  if (best.score < 0.75 && haystack.length >= token.length) {
    for (let start = 0; start + token.length <= haystack.length; start += 1) {
      const window = haystack.slice(start, start + token.length);
      const score = similarity(token, window);
      if (score > best.score) best = { score, snippet: window.trim() };
    }
  }

  return best;
}

/**
 * Drops combining diacritics: `Ärla` → `Arla`.
 *
 * Receipt printers and company registers disagree about whether Swedish
 * merchant names carry their accents, so matching folds them away first.
 */
export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
