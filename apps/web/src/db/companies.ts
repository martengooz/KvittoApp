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
  matchCompanyName,
  newId,
  EMPTY_SYNC_META,
  type Company,
  type ID,
} from '@kvitto/shared';

import { bus } from '../core/events.js';
import { getSettings } from '../core/settings.js';
import {
  CompanyLookupError,
  lookupCompany,
  type CompanyRecord,
  type LookupFailure,
} from '../api/apiverket.js';
import { db, getKv, setKv } from './db.js';

/** How long a "not found" answer is trusted before the API is asked again. */
const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

/** kv key holding org numbers the registry did not know, and when. */
const MISSES_KEY = 'companies:misses';

type MissCache = Record<string, number>;

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

/** Forgets every cached "not found", so they are retried. */
export async function clearCompanyMisses(): Promise<void> {
  await setKv(MISSES_KEY, {});
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
