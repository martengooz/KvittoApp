/**
 * The company store, and the cache-first lookup in front of it.
 *
 * A registry lookup costs an API call against a metered quota, so the rule is
 * simple and absolute: **a company already stored is never looked up again.**
 * Everything else here exists to make that rule hold — including remembering
 * organisation numbers that came back "not found", so a receipt from an
 * unregistered trader does not burn a call on every rescan.
 */

import {
  checkOrgNumber,
  foldForMatching,
  matchCompanyName,
  merchantNameCandidates,
  newId,
  EMPTY_SYNC_META,
  NAME_MATCH_THRESHOLD,
  type Company,
  type ID,
  type NameCandidate,
} from '@kvitto/shared';

import { bus } from '../core/events.js';
import { getSettings } from '../core/settings.js';
import {
  CompanyLookupError,
  lookupCompany,
  searchCompanies,
  type CompanyRecord,
  type CompanySearchHit,
  type LookupFailure,
} from '../api/apiverket.js';
import { db, getKv, setKv } from './db.js';

/** How long a "not found" answer is trusted before the API is asked again. */
const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

/** kv key holding org numbers the registry did not know, and when. */
const MISSES_KEY = 'companies:misses';

/** kv key mapping a folded search term to the organisation number it found. */
const NAME_INDEX_KEY = 'companies:names';

/** kv key holding the rolling daily count of name searches. */
const SEARCH_BUDGET_KEY = 'companies:searchBudget';

type MissCache = Record<string, number>;

/**
 * A resolved search term. `null` records that the term found nothing, which is
 * just as valuable to remember — the whole point is never to spend the same
 * search twice.
 */
type NameIndex = Record<string, { digits: string | null; at: number }>;

interface SearchBudget {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  used: number;
}

/** Reads a stored company by organisation number, in any format. */
export async function getCompany(orgNumber: string): Promise<Company | undefined> {
  const check = checkOrgNumber(orgNumber);
  if (!check.digits) return undefined;
  const stored = await db.companies.get(check.digits);
  return stored && stored.deletedAt === 0 ? stored : undefined;
}

export function listCompanies(): Promise<Company[]> {
  return db.companies.where('deletedAt').equals(0).toArray();
}

export type ResolveOutcome =
  | { status: 'cached'; company: Company }
  | { status: 'fetched'; company: Company }
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
   * Answer from what is already stored or not at all. Set when the user has
   * turned automatic lookups off, so a scan still links a company it has seen
   * before without ever reaching the network.
   */
  cacheOnly?: boolean;
}

/**
 * Resolves an organisation number to a stored {@link Company}.
 *
 * Order matters: local validation, then the local store, then the negative
 * cache, and only then the network. Each step exists to avoid the one after it.
 */
export async function resolveCompany(
  orgNumber: string,
  options: ResolveOptions = {},
): Promise<ResolveOutcome> {
  const check = checkOrgNumber(orgNumber);
  if (!check.valid || !check.digits) return { status: 'skipped', reason: 'invalid-org-number' };

  if (!options.force) {
    const existing = await db.companies.get(check.digits);
    if (existing && existing.deletedAt === 0) {
      // Already known — no API call. Still worth re-checking the name against
      // this particular receipt, which is free and improves over time.
      const updated = await corroborate(existing, options.receiptText);
      return { status: 'cached', company: updated };
    }

    if (await isKnownMiss(check.digits)) {
      return { status: 'skipped', reason: 'not-found' };
    }
  }

  if (options.cacheOnly) return { status: 'skipped', reason: 'not-configured' };

  const settings = getSettings();
  const apiKey = settings.company.apiKey.trim();
  if (!apiKey) return { status: 'skipped', reason: 'not-configured' };

  let record: CompanyRecord;
  try {
    record = await lookupCompany(check.digits, {
      apiKey,
      baseUrl: settings.company.baseUrl,
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
  const now = Date.now();
  const company: Company = {
    ...EMPTY_SYNC_META,
    updatedAt: now,
    dirty: 1,
    id: check.digits,
    ...record,
    nameMatchScore: match?.score ?? null,
    nameConfirmed: match?.confirmed ?? false,
  };

  await db.companies.put(company);
  bus.emit('data:changed', { kinds: ['companies'] });
  return { status: 'fetched', company };
}

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
    updatedAt: Date.now(),
    dirty: 1,
  };
  await db.companies.put(updated);
  bus.emit('data:changed', { kinds: ['companies'] });
  return updated;
}

// --- resolving by name ----------------------------------------------------

/** How long a resolved (or unresolved) search term is trusted. */
const NAME_CACHE_MS = 180 * 24 * 60 * 60 * 1000;

/** Searches attempted for one receipt before giving up. */
const MAX_ATTEMPTS_PER_RECEIPT = 2;

export type NameResolveOutcome =
  | { status: 'cached' | 'fetched'; company: Company; via: NameCandidate; score: number }
  | { status: 'skipped'; reason: LookupFailure };

export interface ResolveByNameOptions {
  /** The full OCR text, used both to pick candidates and to verify the answer. */
  receiptText: string;
  signal?: AbortSignal;
  /** Overrides {@link DEFAULT_SEARCH_BUDGET}. */
  dailyBudget?: number;
}

/**
 * Finds a company from the shop's name when the organisation number could not
 * be read.
 *
 * The name is not verifiable the way a checksummed number is, so this is
 * strictly the weaker path and it is guarded at both ends: candidates that look
 * like OCR noise never reach the API, and a hit is only accepted if the
 * registered name it comes back with can be found in the receipt's own text.
 * A search that resolves is remembered forever, so the second receipt from that
 * shop costs nothing.
 */
export async function resolveCompanyByName(
  options: ResolveByNameOptions,
): Promise<NameResolveOutcome> {
  const candidates = merchantNameCandidates(options.receiptText)
    .filter((candidate) => candidate.searchable)
    .slice(0, MAX_ATTEMPTS_PER_RECEIPT);

  if (candidates.length === 0) return { status: 'skipped', reason: 'no-query' };

  // The cache first, for every candidate, before spending anything.
  const index = await getKv<NameIndex>(NAME_INDEX_KEY, {});
  const unknown: NameCandidate[] = [];

  for (const candidate of candidates) {
    const entry = index[foldForMatching(candidate.query)];
    if (!entry || Date.now() - entry.at > NAME_CACHE_MS) {
      unknown.push(candidate);
      continue;
    }
    if (!entry.digits) continue; // Known to find nothing.

    const stored = await db.companies.get(entry.digits);
    if (stored && stored.deletedAt === 0) {
      const updated = await corroborate(stored, options.receiptText);
      const match = matchCompanyName(updated.name, options.receiptText);
      return { status: 'cached', company: updated, via: candidate, score: match.score };
    }
    // The mapping survived but the company row did not; re-fetch it by number,
    // which uses the plentiful quota rather than the scarce one.
    const outcome = await resolveCompany(entry.digits, { receiptText: options.receiptText });
    if (outcome.status !== 'skipped') {
      const match = matchCompanyName(outcome.company.name, options.receiptText);
      return { status: outcome.status, company: outcome.company, via: candidate, score: match.score };
    }
  }

  if (unknown.length === 0) return { status: 'skipped', reason: 'not-found' };

  const settings = getSettings();
  if (!settings.company.apiKey.trim()) return { status: 'skipped', reason: 'not-configured' };
  if (!settings.company.nameSearch) return { status: 'skipped', reason: 'not-configured' };

  let lastFailure: LookupFailure = 'not-found';

  for (const candidate of unknown) {
    const budget = options.dailyBudget ?? settings.company.searchBudget;
    if (!(await spendSearch(budget))) return { status: 'skipped', reason: 'budget-spent' };

    let hits: CompanySearchHit[];
    try {
      hits = await searchCompanies(candidate.query, {
        apiKey: settings.company.apiKey,
        baseUrl: settings.company.baseUrl,
        signal: options.signal,
      });
    } catch (error) {
      lastFailure = error instanceof CompanyLookupError ? error.failure : 'unavailable';
      // A quota or network failure says nothing about the term, so it is not
      // cached — only a clean "no such company" is.
      if (lastFailure === 'not-found') await rememberName(candidate.query, null);
      continue;
    }

    const best = pickHit(hits, options.receiptText);
    if (!best) {
      await rememberName(candidate.query, null);
      continue;
    }

    await rememberName(candidate.query, best.hit.digits);
    // Go through the by-number path so the stored record always comes from the
    // same endpoint, with the same fields, however it was found.
    const outcome = await resolveCompany(best.hit.digits, {
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

/**
 * Chooses the search hit whose registered name actually appears on the receipt.
 *
 * A substring search for `BAUHAUS` returns every company with those letters in
 * its name, and the receipt itself is the only evidence about which one served
 * this customer. A hit that cannot be found in the text is rejected outright
 * rather than accepted as a best guess — a wrong company filed silently is
 * worse than none.
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
    const score = match.score + (hit.active === false ? -0.05 : 0);
    if (!best || score > best.score) best = { hit, score: match.score };
  }
  return best;
}

async function rememberName(query: string, digits: string | null): Promise<void> {
  const index = await getKv<NameIndex>(NAME_INDEX_KEY, {});
  index[foldForMatching(query)] = { digits, at: Date.now() };
  await setKv(NAME_INDEX_KEY, index);
}

/** Consumes one unit of today's search budget. False when it is spent. */
async function spendSearch(limit: number): Promise<boolean> {
  const today = localDay();
  const budget = await getKv<SearchBudget>(SEARCH_BUDGET_KEY, { day: today, used: 0 });
  const used = budget.day === today ? budget.used : 0;
  if (used >= Math.max(0, limit)) return false;
  await setKv(SEARCH_BUDGET_KEY, { day: today, used: used + 1 });
  return true;
}

/** Today's searches, for the Settings screen. */
export async function searchBudgetUsed(): Promise<number> {
  const budget = await getKv<SearchBudget>(SEARCH_BUDGET_KEY, { day: localDay(), used: 0 });
  return budget.day === localDay() ? budget.used : 0;
}

function localDay(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// --- negative cache -------------------------------------------------------

async function isKnownMiss(digits: string): Promise<boolean> {
  const misses = await getKv<MissCache>(MISSES_KEY, {});
  const at = misses[digits];
  if (at === undefined) return false;
  if (Date.now() - at < NEGATIVE_CACHE_MS) return true;

  // Expired: forget it so the next scan asks again.
  delete misses[digits];
  await setKv(MISSES_KEY, misses);
  return false;
}

async function rememberMiss(digits: string): Promise<void> {
  const misses = await getKv<MissCache>(MISSES_KEY, {});
  misses[digits] = Date.now();
  await setKv(MISSES_KEY, misses);
}

/** Forgets every cached "not found" and every resolved name, so both retry. */
export async function clearCompanyMisses(): Promise<void> {
  await setKv(MISSES_KEY, {});
  await setKv(NAME_INDEX_KEY, {});
}

/**
 * Manually records a company without a lookup — used when the user corrects
 * one by hand, and by tests.
 */
export async function upsertCompany(record: CompanyRecord & { id?: ID }): Promise<Company> {
  const check = checkOrgNumber(record.orgNumber);
  const id = record.id ?? check.digits ?? newId();
  const existing = await db.companies.get(id);

  const company: Company = {
    ...EMPTY_SYNC_META,
    ...existing,
    ...record,
    id,
    deletedAt: 0,
    updatedAt: Date.now(),
    dirty: 1,
    nameMatchScore: existing?.nameMatchScore ?? null,
    nameConfirmed: existing?.nameConfirmed ?? false,
  };
  await db.companies.put(company);
  bus.emit('data:changed', { kinds: ['companies'] });
  return company;
}

/** Tombstones companies no receipt references. */
export async function purgeUnreferencedCompanies(): Promise<number> {
  const referenced = new Set<string>();
  await db.receipts.each((receipt) => {
    if (receipt.companyId) referenced.add(receipt.companyId);
  });

  const now = Date.now();
  let removed = 0;
  for (const company of await listCompanies()) {
    if (referenced.has(company.id)) continue;
    await db.companies.update(company.id, { deletedAt: now, updatedAt: now, dirty: 1 });
    removed += 1;
  }
  if (removed > 0) bus.emit('data:changed', { kinds: ['companies'] });
  return removed;
}
