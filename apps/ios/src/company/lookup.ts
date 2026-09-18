/**
 * Cache-first company lookup, and the daily budget that guards its weaker,
 * name-based path.
 *
 * A registry lookup costs an API call against a metered quota, so the rule is
 * simple and absolute: **a company already stored is never looked up again.**
 * Everything here exists to make that rule hold - including remembering
 * organisation numbers that came back "not found", so a receipt from an
 * unregistered trader does not burn a call on every rescan.
 *
 * The API client itself lives in `@kvitto/shared`, shared with the web app,
 * because that is the part that must not diverge when the registry's contract
 * changes. This policy is a second implementation of `apps/web/src/company/
 * lookup.ts`, deliberately: the web copy is untested and reaches straight into
 * its own Dexie tables and settings singleton, so unifying them would mean
 * rewriting working, uncovered code. **If you change a rule here, change it
 * there too.**
 *
 * Everything is injected rather than imported, which is what lets these rules
 * be tested against a real SQLite database with no network at all.
 */

import {
  CompanyLookupError,
  EMPTY_SYNC_META,
  NAME_MATCH_THRESHOLD,
  checkOrgNumber,
  foldForMatching,
  lookupCompany,
  matchCompanyName,
  merchantNameCandidates,
  searchCompanies,
  type Company,
  type CompanyRecord,
  type CompanySearchHit,
  type LookupFailure,
  type NameCandidate,
} from '@kvitto/shared';

/** How long a "not found" answer is trusted before the API is asked again. */
export const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a resolved (or unresolved) search term is trusted. */
export const NAME_CACHE_MS = 180 * 24 * 60 * 60 * 1000;

/** Searches attempted for one receipt before giving up. */
const MAX_ATTEMPTS_PER_RECEIPT = 2;

/** kv key holding org numbers the registry did not know, and when. */
const MISSES_KEY = 'companies:misses';

/** kv key mapping a folded search term to the organisation number it found. */
const NAME_INDEX_KEY = 'companies:names';

/** kv key holding the rolling daily count of name searches. */
const SEARCH_BUDGET_KEY = 'companies:searchBudget';

type MissCache = Record<string, number>;

/**
 * A resolved search term. `null` records that the term found nothing, which is
 * just as valuable to remember - the whole point is never to spend the same
 * search twice.
 */
type NameIndex = Record<string, { digits: string | null; at: number }>;

interface SearchBudget {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  used: number;
}

export interface CompanySettings {
  apiKey: string;
  baseUrl?: string;
  /** Whether the scarce name-search endpoint may be used at all. */
  nameSearch: boolean;
  /** Name searches allowed per local day. */
  searchBudget: number;
}

/** What the lookup needs from the app, so none of it has to be imported. */
export interface CompanyLookupPorts {
  getCompany(digits: string): Promise<Company | null>;
  putCompany(company: Company): Promise<void>;
  getKeyValue(key: string): Promise<string | null>;
  setKeyValue(key: string, value: string): Promise<void>;
  /** Read per call, so turning lookups off applies to the next scan. */
  getSettings(): Promise<CompanySettings>;
  now?: () => number;
  /** Swapped in tests; production passes the shared client through. */
  api?: {
    lookupCompany: typeof lookupCompany;
    searchCompanies: typeof searchCompanies;
  };
}

export type ResolveOutcome =
  | { status: 'cached'; company: Company }
  | { status: 'fetched'; company: Company }
  | { status: 'skipped'; reason: LookupFailure };

export type NameResolveOutcome =
  | { status: 'cached' | 'fetched'; company: Company; via: NameCandidate; score: number }
  | { status: 'skipped'; reason: LookupFailure };

export interface ResolveOptions {
  /**
   * Receipt text used to corroborate the registered name. When supplied, the
   * match score is stored on the company.
   */
  receiptText?: string;
  signal?: AbortSignal;
  /** Ignore the cache and re-query. Only for an explicit user action. */
  force?: boolean;
  /**
   * Answer from what is already stored or not at all. Set when automatic
   * lookups are off, so a scan still links a company it has seen before
   * without ever reaching the network.
   */
  cacheOnly?: boolean;
}

export interface ResolveByNameOptions {
  /** The full OCR text, used both to pick candidates and to verify the answer. */
  receiptText: string;
  signal?: AbortSignal;
  dailyBudget?: number;
}

export interface CompanyLookupService {
  /** Resolves an organisation number to a stored company. */
  resolve(orgNumber: string, options?: ResolveOptions): Promise<ResolveOutcome>;
  /** Finds a company from the shop's name when the number could not be read. */
  resolveByName(options: ResolveByNameOptions): Promise<NameResolveOutcome>;
  /** Today's name searches, for the settings screen. */
  searchBudgetUsed(): Promise<number>;
  /** Forgets every cached "not found" and every resolved name, so both retry. */
  clearMisses(): Promise<void>;
}

export function createCompanyLookup(ports: CompanyLookupPorts): CompanyLookupService {
  const now = ports.now ?? (() => Date.now());
  const api = ports.api ?? { lookupCompany, searchCompanies };

  async function readJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await ports.getKeyValue(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt cache is a cache miss, never a failed lookup. The worst case
      // is one extra API call; throwing here would break scanning outright.
      return fallback;
    }
  }

  const writeJson = (key: string, value: unknown) => ports.setKeyValue(key, JSON.stringify(value));

  /**
   * Re-scores a stored company's name against fresh receipt text.
   *
   * Only ever raises the score. A receipt whose OCR came out badly should not
   * downgrade a company that a cleaner scan already confirmed.
   */
  async function corroborate(company: Company, receiptText?: string): Promise<Company> {
    if (!receiptText) return company;

    const match = matchCompanyName(company.name, receiptText);
    if (match.score <= (company.nameMatchScore ?? 0)) return company;

    const updated: Company = {
      ...company,
      nameMatchScore: match.score,
      nameConfirmed: company.nameConfirmed || match.confirmed,
      updatedAt: now(),
      dirty: 1,
    };
    await ports.putCompany(updated);
    return updated;
  }

  async function isKnownMiss(digits: string): Promise<boolean> {
    const misses = await readJson<MissCache>(MISSES_KEY, {});
    const at = misses[digits];
    if (at === undefined) return false;
    if (now() - at < NEGATIVE_CACHE_MS) return true;

    // Expired: forget it so the next scan asks again.
    delete misses[digits];
    await writeJson(MISSES_KEY, misses);
    return false;
  }

  async function rememberMiss(digits: string): Promise<void> {
    const misses = await readJson<MissCache>(MISSES_KEY, {});
    misses[digits] = now();
    await writeJson(MISSES_KEY, misses);
  }

  async function rememberName(query: string, digits: string | null): Promise<void> {
    const index = await readJson<NameIndex>(NAME_INDEX_KEY, {});
    index[foldForMatching(query)] = { digits, at: now() };
    await writeJson(NAME_INDEX_KEY, index);
  }

  function localDay(): string {
    const date = new Date(now());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  /** Consumes one unit of today's search budget. False when it is spent. */
  async function spendSearch(limit: number): Promise<boolean> {
    const today = localDay();
    const budget = await readJson<SearchBudget>(SEARCH_BUDGET_KEY, { day: today, used: 0 });
    const used = budget.day === today ? budget.used : 0;
    if (used >= Math.max(0, limit)) return false;
    await writeJson(SEARCH_BUDGET_KEY, { day: today, used: used + 1 });
    return true;
  }

  /**
   * Chooses the search hit whose registered name actually appears on the
   * receipt.
   *
   * A substring search for `BAUHAUS` returns every company with those letters
   * in its name, and the receipt itself is the only evidence about which one
   * served this customer. A hit that cannot be found in the text is rejected
   * outright rather than accepted as a best guess - a wrong company filed
   * silently is worse than none.
   */
  function pickHit(
    hits: CompanySearchHit[],
    receiptText: string,
  ): { hit: CompanySearchHit; score: number } | null {
    let best: { hit: CompanySearchHit; score: number } | null = null;

    for (const hit of hits) {
      const match = matchCompanyName(hit.name, receiptText);
      if (match.score < NAME_MATCH_THRESHOLD) continue;
      // Ties go to the active company: a deregistered namesake did not sell
      // anything today.
      const ranked = match.score + (hit.active === false ? -0.05 : 0);
      if (!best || ranked > best.score) best = { hit, score: match.score };
    }
    return best;
  }

  async function resolve(orgNumber: string, options: ResolveOptions = {}): Promise<ResolveOutcome> {
    const check = checkOrgNumber(orgNumber);
    if (!check.valid || !check.digits) return { status: 'skipped', reason: 'invalid-org-number' };

    if (!options.force) {
      const existing = await ports.getCompany(check.digits);
      if (existing && existing.deletedAt === 0) {
        // Already known - no API call. Still worth re-checking the name
        // against this particular receipt, which is free and improves over
        // time.
        return { status: 'cached', company: await corroborate(existing, options.receiptText) };
      }

      if (await isKnownMiss(check.digits)) {
        return { status: 'skipped', reason: 'not-found' };
      }
    }

    if (options.cacheOnly) return { status: 'skipped', reason: 'not-configured' };

    const settings = await ports.getSettings();
    const apiKey = settings.apiKey.trim();
    if (!apiKey) return { status: 'skipped', reason: 'not-configured' };

    let record: CompanyRecord;
    try {
      record = await api.lookupCompany(check.digits, {
        apiKey,
        baseUrl: settings.baseUrl,
        signal: options.signal,
      });
    } catch (error) {
      const failure = error instanceof CompanyLookupError ? error.failure : 'unavailable';
      // Only a definitive "no such company" is cached. A quota or network
      // failure says nothing about whether the company exists.
      if (failure === 'not-found') await rememberMiss(check.digits);
      return { status: 'skipped', reason: failure };
    }

    const match = options.receiptText ? matchCompanyName(record.name, options.receiptText) : null;
    const company: Company = {
      ...EMPTY_SYNC_META,
      updatedAt: now(),
      dirty: 1,
      id: check.digits,
      ...record,
      nameMatchScore: match?.score ?? null,
      nameConfirmed: match?.confirmed ?? false,
    };

    await ports.putCompany(company);
    return { status: 'fetched', company };
  }

  /**
   * The name is not verifiable the way a checksummed number is, so this is
   * strictly the weaker path and it is guarded at both ends: candidates that
   * look like OCR noise never reach the API, and a hit is only accepted if the
   * registered name it comes back with can be found in the receipt's own text.
   * A search that resolves is remembered forever, so the second receipt from
   * that shop costs nothing.
   */
  async function resolveByName(options: ResolveByNameOptions): Promise<NameResolveOutcome> {
    const candidates = merchantNameCandidates(options.receiptText)
      .filter((candidate) => candidate.searchable)
      .slice(0, MAX_ATTEMPTS_PER_RECEIPT);

    if (candidates.length === 0) return { status: 'skipped', reason: 'no-query' };

    // The cache first, for every candidate, before spending anything.
    const index = await readJson<NameIndex>(NAME_INDEX_KEY, {});
    const unknown: NameCandidate[] = [];

    for (const candidate of candidates) {
      const entry = index[foldForMatching(candidate.query)];
      if (!entry || now() - entry.at > NAME_CACHE_MS) {
        unknown.push(candidate);
        continue;
      }
      if (!entry.digits) continue; // Known to find nothing.

      const stored = await ports.getCompany(entry.digits);
      if (stored && stored.deletedAt === 0) {
        const updated = await corroborate(stored, options.receiptText);
        const match = matchCompanyName(updated.name, options.receiptText);
        return { status: 'cached', company: updated, via: candidate, score: match.score };
      }
      // The mapping survived but the company row did not; re-fetch it by
      // number, which uses the plentiful quota rather than the scarce one.
      const outcome = await resolve(entry.digits, { receiptText: options.receiptText });
      if (outcome.status !== 'skipped') {
        const match = matchCompanyName(outcome.company.name, options.receiptText);
        return { status: outcome.status, company: outcome.company, via: candidate, score: match.score };
      }
    }

    if (unknown.length === 0) return { status: 'skipped', reason: 'not-found' };

    const settings = await ports.getSettings();
    if (!settings.apiKey.trim()) return { status: 'skipped', reason: 'not-configured' };
    if (!settings.nameSearch) return { status: 'skipped', reason: 'not-configured' };

    let lastFailure: LookupFailure = 'not-found';

    for (const candidate of unknown) {
      const budget = options.dailyBudget ?? settings.searchBudget;
      if (!(await spendSearch(budget))) return { status: 'skipped', reason: 'budget-spent' };

      let hits: CompanySearchHit[];
      try {
        hits = await api.searchCompanies(candidate.query, {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          signal: options.signal,
        });
      } catch (error) {
        lastFailure = error instanceof CompanyLookupError ? error.failure : 'unavailable';
        // A quota or network failure says nothing about the term, so it is not
        // cached - only a clean "no such company" is.
        if (lastFailure === 'not-found') await rememberName(candidate.query, null);
        continue;
      }

      const best = pickHit(hits, options.receiptText);
      if (!best) {
        await rememberName(candidate.query, null);
        continue;
      }

      await rememberName(candidate.query, best.hit.digits);
      // Go through the by-number path so the stored record always comes from
      // the same endpoint, with the same fields, however it was found.
      const outcome = await resolve(best.hit.digits, {
        receiptText: options.receiptText,
        signal: options.signal,
      });
      if (outcome.status === 'skipped') {
        lastFailure = outcome.reason;
        continue;
      }
      return { status: outcome.status, company: outcome.company, via: candidate, score: best.score };
    }

    return { status: 'skipped', reason: lastFailure };
  }

  return {
    resolve,
    resolveByName,

    async searchBudgetUsed(): Promise<number> {
      const budget = await readJson<SearchBudget>(SEARCH_BUDGET_KEY, { day: localDay(), used: 0 });
      return budget.day === localDay() ? budget.used : 0;
    },

    async clearMisses(): Promise<void> {
      await writeJson(MISSES_KEY, {});
      await writeJson(NAME_INDEX_KEY, {});
    },
  };
}
