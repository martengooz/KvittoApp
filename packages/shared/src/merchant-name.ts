/**
 * Guessing the shop's name from the top of a receipt.
 *
 * Needed because the organisation number is the good identifier and it is not
 * always readable: it may be printed in 6 pt at the very bottom, folded into a
 * crease, or simply absent. When it is, the name is the only handle left — and
 * unlike the number it cannot be checksum-verified, so everything here is
 * scored and offered as *candidates* rather than an answer.
 *
 * Three sources feed the guess, because on real receipts the obvious one is
 * the least reliable:
 *
 * 1. **The header lines.** The trade name is near the top, above the address.
 *    Position does most of the scoring.
 * 2. **The web address in the footer.** `www.BAUHAUS.se` is, on the fixtures,
 *    the single best source there is — a wordmark set in a custom typeface is
 *    exactly what OCR mangles (`BAUHAUS` came back as `AO0UHANE`), while the
 *    same name in the footer's plain monospace URL reads perfectly.
 * 3. **Names that repeat.** A shop prints itself in the header, the footer and
 *    the card slip; noise does not repeat.
 */

import { foldForMatching, stripAccents } from './fuzzy.js';

/** How many leading lines are considered for the header source. */
const HEAD_LINES = 14;

/** Longest a line can be and still plausibly be a shop name. */
const MAX_NAME_LENGTH = 60;

/**
 * Lines that are structurally something else.
 *
 * Tested against accent-stripped, lower-cased text, because OCR loses å/ä/ö
 * constantly and `Öppettider` comes back as `Oppettider`.
 */
const NOT_A_NAME = [
  // Swedish postal address: five digits then a place, or a street with a number.
  /^\d{3}\s?\d{2}\b/,
  // A street line: the street noun may be glued to a place name, as in
  // `Nynasvagen 600`, so no word boundary is required before it.
  /(gatan|vagen|gata|vag|torget|plan|allen|box)\s*\d/i,
  // `S-142 51 Skogas` — a postal code with a country prefix.
  /^[a-z]{1,2}-\d{3}\s?\d{2}\b/i,
  // Contact details.
  /^(tel|telefon|fax|e-?post|mail|epost)\b/i,
  /^\+?\d[\d\s()-]{6,}$/,
  /(www\.|https?:|@|\.se\b|\.com\b)/i,
  // Registry lines — the org number has its own reader.
  /\b(org\.?\s?nr|orgnr|momsreg|vat|f-?skatt)\b/i,
  // Till and receipt headers.
  /^(kvitto|kassakvitto|kopkvitto|foljesedel|faktura|kassa|butik|terminal|kassor|expedit|kund)\b/i,
  /\b(kvittonr|kvitto\s?nr|bongnr|butiksnr)\b/i,
  // Anything that is mostly an amount, a date or a time.
  /^\s*[\d\s.,:/-]+\s*(kr|sek)?\s*$/i,
  /\b\d{1,2}[:.]\d{2}\b/,
];

/** Words that are part of a legal name but say nothing about which company. */
const LEGAL_SUFFIX =
  /\b(ab|aktiebolag|hb|kb|ekonomisk|forening|ek\.?\s?for|publ|handelsbolag|kommanditbolag|stiftelse)\b/gi;

/** Where a candidate came from. Surfaced so a caller can weigh them. */
export type NameSource = 'header' | 'domain' | 'repeated';

export interface NameCandidate {
  /** The text as printed, trimmed. */
  text: string;
  /** The query to send to a registry search: trimmed of legal-form noise. */
  query: string;
  /** 0..1. Higher means more likely to be the shop's name. */
  confidence: number;
  /** Which line of the receipt it came from, 0-based. */
  line: number;
  source: NameSource;
  /**
   * Whether this is worth spending a registry search on. Search quota is the
   * scarcest thing in the whole app — 20 calls a day on a free key — so a
   * candidate that is plainly OCR noise must not consume one.
   */
  searchable: boolean;
}

/**
 * Returns plausible merchant names from OCR text, best first.
 *
 * Deliberately generous: a registry search can be given two or three tries
 * cheaply, and the fuzzy match against the receipt afterwards is what actually
 * decides. What matters is that the *right* name is somewhere in the list.
 */
export function merchantNameCandidates(text: string): NameCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const found = new Map<string, NameCandidate>();

  /** Keeps the best-scoring candidate per distinct name. */
  const offer = (candidate: NameCandidate): void => {
    const key = foldForMatching(candidate.query);
    if (key.length < 2) return;
    const existing = found.get(key);
    if (!existing || candidate.confidence > existing.confidence) found.set(key, candidate);
  };

  for (const [index, line] of lines.slice(0, HEAD_LINES).entries()) {
    // Checked before tidying, because tidying is what removes the decimal
    // comma that makes a price recognisable as one.
    if (PRICED_LINE.test(line)) continue;
    const cleaned = tidy(line);
    if (!plausible(cleaned)) continue;
    const query = toQuery(cleaned);
    if (query.length < 2) continue;
    offer({
      text: cleaned,
      query,
      confidence: scoreCandidate(cleaned, index),
      line: index,
      source: 'header',
      searchable: looksSearchable(query),
    });
  }

  for (const candidate of domainCandidates(lines)) offer(candidate);
  for (const candidate of repeatedCandidates(lines)) offer(candidate);

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

/**
 * Domain labels, wherever they appear.
 *
 * Spaces are allowed around the dots because OCR inserts them freely —
 * `www . BAUHAUS. se` is what the fixture actually reads.
 */
const DOMAIN =
  /(?:www\s*\.\s*)?([\p{L}\d][\p{L}\d-]{1,30})\s*\.\s*(se|com|nu|net|org|dk|no|fi|eu)\b/giu;

/** Domain labels that name a platform rather than the shop. */
const GENERIC_DOMAIN = new Set([
  'www', 'mail', 'email', 'info', 'shop', 'butik', 'kundtjanst', 'support',
  'facebook', 'instagram', 'google', 'apple', 'youtube', 'twitter', 'linkedin',
  'klarna', 'swish', 'visa', 'mastercard', 'nets', 'verifone', 'worldline',
]);

/**
 * Words tacked onto a domain that are not part of the name a registry knows.
 * `scandichotels.com` is Scandic Hotels AB; searching the concatenation finds
 * nothing, because the registry does a substring match on the real name.
 */
const DOMAIN_SUFFIX =
  /(hotels?|hotell|gruppen|group|sverige|sweden|online|store|shopen|butiken|sverigeab)$/i;

function domainCandidates(lines: string[]): NameCandidate[] {
  const out: NameCandidate[] = [];

  for (const [index, line] of lines.entries()) {
    DOMAIN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DOMAIN.exec(line)) !== null) {
      const label = match[1]!.replace(/-/g, ' ').trim();
      if (label.length < 3 || GENERIC_DOMAIN.has(label.toLowerCase())) continue;

      // A domain is deliberately near the top of the list: it is plain text in
      // a plain face, which is the one thing on a receipt OCR never fumbles.
      out.push({
        text: match[0].trim(),
        query: label,
        confidence: 0.95,
        line: index,
        source: 'domain',
        searchable: looksSearchable(label),
      });

      // `scandichotels` also gets offered as `scandic`, one notch lower.
      const trimmed = label.replace(DOMAIN_SUFFIX, '').trim();
      if (trimmed.length >= 3 && trimmed.toLowerCase() !== label.toLowerCase()) {
        out.push({
          text: match[0].trim(),
          query: trimmed,
          confidence: 0.85,
          line: index,
          source: 'domain',
          searchable: looksSearchable(trimmed),
        });
      }
    }
  }
  return out;
}

/** Shortest token that repeating says anything about. */
const MIN_REPEATED_LENGTH = 4;

/**
 * Words that turn up more than once in a mostly-alphabetic form.
 *
 * Weak on its own, so it is scored below the other two sources — but it is the
 * one source that survives a header the OCR could not read at all.
 */
function repeatedCandidates(lines: string[]): NameCandidate[] {
  const counts = new Map<string, { word: string; line: number; count: number }>();

  for (const [index, line] of lines.entries()) {
    for (const word of line.match(/\p{L}[\p{L}&'-]{2,}/gu) ?? []) {
      if (word.length < MIN_REPEATED_LENGTH) continue;
      const key = foldForMatching(word);
      if (key.length < MIN_REPEATED_LENGTH || STOPWORDS.has(key)) continue;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { word, line: index, count: 1 });
    }
  }

  return [...counts.values()]
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((entry) => ({
      text: entry.word,
      query: entry.word,
      confidence: 0.55 + Math.min(0.1, entry.count * 0.02),
      line: entry.line,
      source: 'repeated' as const,
      searchable: looksSearchable(entry.word),
    }));
}

/** Swedish receipt vocabulary — common enough to repeat on any receipt. */
const STOPWORDS = new Set([
  'moms', 'total', 'totalt', 'summa', 'delsumma', 'netto', 'brutto', 'kontant',
  'kort', 'betalning', 'betalt', 'kvitto', 'kassa', 'butik', 'datum', 'tack',
  'besoket', 'valkommen', 'oppettider', 'pris', 'rabatt', 'pant', 'styck',
  'antal', 'artikel', 'vara', 'varor', 'retur', 'bytesratt', 'garanti',
  'kundnr', 'kundenr', 'terminal', 'referens', 'kopvillkor', 'villkor',
  'gamla', 'vagen', 'gatan', 'sparade', 'organisationsnr', 'telefon',
]);

/**
 * A line that ends in an amount is a line item, whatever its words say.
 *
 * This is what separates `SURFORM HOBBYBL      69,95` from a shop name, and it
 * matters because a receipt's first readable line is often the first product —
 * the header above it having been a logo the OCR could not read.
 */
const PRICED_LINE = /\d+[.,]\d{2}\s*(kr|sek|:-)?\s*[*a-z]?\s*$/i;

/** Strips the decoration receipts print around a logo line. */
function tidy(line: string): string {
  return line
    // Leading and trailing runs of the characters used as rules and borders.
    .replace(/^[\s*=~_·•|<>[\]{}()#-]+/, '')
    .replace(/[\s*=~_·•|<>[\]{}()#-]+$/, '')
    // OCR routinely reads a wide-tracked logo as `S c a n d i c`.
    .replace(/\b(?:\p{L}\s){2,}\p{L}\b/gu, (spaced) => spaced.replace(/\s+/g, ''))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function plausible(line: string): boolean {
  if (line.length < 2 || line.length > MAX_NAME_LENGTH) return false;

  const folded = stripAccents(line).toLowerCase();
  if (NOT_A_NAME.some((pattern) => pattern.test(folded))) return false;

  // A name is mostly letters. Two digits in `7-Eleven` is fine; a line that is
  // half numbers is a price list or an address.
  const letters = (line.match(/\p{L}/gu) ?? []).length;
  const digits = (line.match(/\d/gu) ?? []).length;
  if (letters < 2) return false;
  if (digits > letters) return false;

  return true;
}

/** The registry query: the name without its legal-form suffix. */
function toQuery(line: string): string {
  return line
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^\p{L}\p{N}\s&'-]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Scores a candidate line.
 *
 * Position dominates, because on a receipt the logo is at the top and nothing
 * else is. The rest are weak signals that break ties between the first three
 * lines, which is where the real ambiguity lives.
 */
function scoreCandidate(line: string, index: number): number {
  // 1.0 at the first line, decaying to ~0.45 by the twelfth.
  let score = 0.5 + 0.5 * Math.exp(-index / 3);

  // Shops print their name in capitals far more often than anything else in the
  // header block does.
  const letters = line.match(/\p{L}/gu) ?? [];
  const upper = letters.filter((character) => character === character.toUpperCase());
  if (letters.length >= 3 && upper.length / letters.length > 0.8) score += 0.12;

  // An explicit legal form is near-proof that the line is a company name.
  if (/\b(AB|HB|KB|Aktiebolag)\b/.test(line)) score += 0.15;

  // One or two words is what a trade name looks like; a sentence is not one.
  const words = line.split(/\s+/).length;
  if (words > 5) score -= 0.2;

  // Digits are allowed but mildly suspicious.
  if (/\d/.test(line)) score -= 0.05;

  return Math.max(0, Math.min(1, score));
}

/**
 * Whether a query is a real word rather than what OCR does to a logo.
 *
 * `BAUHAUS` set in a custom face comes back as `AO0UHANE`, `AEFRAUHNKAVE`,
 * `iLLV S`. None of them can match anything in a registry, but each would
 * still spend one of the day's twenty searches, so they are filtered here
 * instead of at the API.
 */
export function looksSearchable(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 3 || trimmed.length > 40) return false;

  // A digit inside a word — `AO0UHANE`, `tkas5e` — is OCR substituting a
  // look-alike.
  if (/\p{L}\d|\d\p{L}/u.test(trimmed)) return false;

  // A number standing on its own is a house number or a quantity that survived
  // the line filters: `Nynasvagen 600`, `PEPPAR ROD KL 1`. No shop is named
  // that, and each one would cost a search from a twenty-a-day quota.
  if (/(?:^|\s)\d+(?:$|\s)/.test(trimmed)) return false;

  const letters = trimmed.match(/\p{L}/gu) ?? [];
  if (letters.length < 3) return false;

  // Case that flips inside a word is a rendering artefact, not a name.
  if (/\p{Ll}\p{Lu}/u.test(trimmed.replace(/(?<=\s|^)\p{Lu}/gu, ''))) return false;

  // Swedish words run about 35-45 % vowels. Far outside that is not a word.
  const vowels = trimmed.match(/[aeiouyåäöAEIOUYÅÄÖ]/g) ?? [];
  const ratio = vowels.length / letters.length;
  if (ratio < 0.2 || ratio > 0.7) return false;

  // Four consonants in a row happens in Swedish (`skjorta`), five does not.
  if (/[^aeiouyåäö\s\W]{5,}/i.test(trimmed)) return false;

  return true;
}

