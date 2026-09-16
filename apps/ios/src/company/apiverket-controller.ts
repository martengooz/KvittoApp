import {
  NAME_MATCH_THRESHOLD,
  checkOrgNumber,
  foldForMatching,
  matchCompanyName,
  merchantNameCandidates,
} from '@kvitto/shared';

export type CompanyLookupFailure =
  | 'not-configured'
  | 'invalid-org-number'
  | 'not-found'
  | 'unauthorised'
  | 'rate-limited'
  | 'unavailable'
  | 'offline'
  | 'no-query'
  | 'budget-spent';

export interface CompanyRecord {
  orgNumber: string;
  name: string;
  legalForm: string | null;
  status: string | null;
  active: boolean | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  industry: string | null;
  raw: Record<string, unknown>;
  source: 'apiverket';
  fetchedAt: number;
}

export interface CompanySearchHit extends CompanyRecord {
  digits: string;
}

export interface StoredCompany extends CompanyRecord {
  id: string;
  nameMatchScore: number | null;
  nameConfirmed: boolean;
  updatedAt: number;
  deletedAt: number;
}

export interface CompanyCacheStore {
  getCompany(id: string): Promise<StoredCompany | null>;
  putCompany(company: StoredCompany): Promise<void>;
  getKv<T>(key: string, fallback: T): Promise<T>;
  setKv<T>(key: string, value: T): Promise<void>;
}

export interface CompanyRegistryClient {
  lookupCompany(digits: string, options: { apiKey: string; baseUrl?: string; signal?: AbortSignal }): Promise<CompanyRecord>;
  searchCompanies(query: string, options: { apiKey: string; baseUrl?: string; signal?: AbortSignal }): Promise<CompanySearchHit[]>;
}

export interface CompanyLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

const nullLogger: CompanyLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
};

export class CompanyLookupError extends Error {
  readonly failure: CompanyLookupFailure;
  readonly retryable: boolean;

  constructor(failure: CompanyLookupFailure, message: string, retryable = false) {
    super(message);
    this.name = 'CompanyLookupError';
    this.failure = failure;
    this.retryable = retryable;
  }
}

interface NameIndexEntry {
  digits: string | null;
  at: number;
}

type NameIndex = Record<string, NameIndexEntry>;
type MissCache = Record<string, number>;

interface SearchBudget {
  day: string;
  used: number;
}

export interface ApiverketCredentials {
  apiKey: string;
  baseUrl?: string;
  nameSearchEnabled: boolean;
  dailySearchBudget: number;
}

export interface ApiverketControllerOptions {
  store: CompanyCacheStore;
  client: CompanyRegistryClient;
  getCredentials: () => ApiverketCredentials | Promise<ApiverketCredentials>;
  now?: () => number;
  logger?: CompanyLogger;
}

export type ResolveOutcome =
  | { status: 'cached' | 'fetched'; company: StoredCompany }
  | { status: 'skipped'; reason: CompanyLookupFailure };

export type NameResolveOutcome =
  | { status: 'cached' | 'fetched'; company: StoredCompany; score: number }
  | { status: 'skipped'; reason: CompanyLookupFailure };

const MISSES_KEY = 'company:misses';
const NAME_INDEX_KEY = 'company:name-index';
const SEARCH_BUDGET_KEY = 'company:search-budget';

const NEGATIVE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const NAME_CACHE_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_NAME_ATTEMPTS = 2;

function redactApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (!trimmed) return '[none]';
  if (trimmed.length < 8) return '[redacted]';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-2)}`;
}

function toCompany(record: CompanyRecord, now: number): StoredCompany {
  return {
    id: checkOrgNumber(record.orgNumber).digits ?? record.orgNumber.replace(/\D/g, ''),
    orgNumber: record.orgNumber,
    name: record.name,
    legalForm: record.legalForm,
    status: record.status,
    active: record.active,
    address: record.address,
    postalCode: record.postalCode,
    city: record.city,
    industry: record.industry,
    raw: record.raw,
    source: 'apiverket',
    fetchedAt: record.fetchedAt,
    nameMatchScore: null,
    nameConfirmed: false,
    updatedAt: now,
    deletedAt: 0,
  };
}

function localDay(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export class ApiverketLookupController {
  private readonly store: CompanyCacheStore;
  private readonly client: CompanyRegistryClient;
  private readonly getCredentials: () => Promise<ApiverketCredentials>;
  private readonly now: () => number;
  private readonly logger: CompanyLogger;

  constructor(options: ApiverketControllerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.getCredentials = async () => options.getCredentials();
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? nullLogger;
  }

  async resolveCompany(
    orgNumber: string,
    options: { receiptText?: string; force?: boolean; cacheOnly?: boolean; signal?: AbortSignal } = {},
  ): Promise<ResolveOutcome> {
    const check = checkOrgNumber(orgNumber);
    if (!check.valid || !check.digits) {
      return { status: 'skipped', reason: 'invalid-org-number' };
    }

    if (!options.force) {
      const existing = await this.store.getCompany(check.digits);
      if (existing && existing.deletedAt === 0) {
        const updated = await this.corroborate(existing, options.receiptText);
        return { status: 'cached', company: updated };
      }

      if (await this.isKnownMiss(check.digits)) {
        return { status: 'skipped', reason: 'not-found' };
      }
    }

    if (options.cacheOnly) return { status: 'skipped', reason: 'not-configured' };

    const credentials = await this.getCredentials();
    const apiKey = credentials.apiKey.trim();
    if (!apiKey) return { status: 'skipped', reason: 'not-configured' };

    this.logger.debug('apiverket.lookup.start', {
      orgNumber: check.formatted,
      apiKey: redactApiKey(apiKey),
      baseUrlConfigured: Boolean(credentials.baseUrl),
    });

    let record: CompanyRecord;
    try {
      record = await this.client.lookupCompany(check.digits, {
        apiKey,
        baseUrl: credentials.baseUrl,
        signal: options.signal,
      });
    } catch (error) {
      const failure = error instanceof CompanyLookupError ? error.failure : 'unavailable';
      if (failure === 'not-found') await this.rememberMiss(check.digits);
      this.logger.warn('apiverket.lookup.failed', {
        orgNumber: check.formatted,
        reason: failure,
        apiKey: redactApiKey(apiKey),
      });
      return { status: 'skipped', reason: failure };
    }

    const now = this.now();
    const stored = await this.corroborate(toCompany(record, now), options.receiptText);
    await this.store.putCompany(stored);

    this.logger.info('apiverket.lookup.fetched', {
      companyId: stored.id,
      name: stored.name,
      apiKey: redactApiKey(apiKey),
    });

    return { status: 'fetched', company: stored };
  }

  async resolveCompanyByName(
    receiptText: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<NameResolveOutcome> {
    const candidates = merchantNameCandidates(receiptText)
      .filter((candidate) => candidate.searchable)
      .slice(0, MAX_NAME_ATTEMPTS);

    if (candidates.length === 0) return { status: 'skipped', reason: 'no-query' };

    const index = await this.store.getKv<NameIndex>(NAME_INDEX_KEY, {});
    const unknownQueries: string[] = [];

    for (const candidate of candidates) {
      const folded = foldForMatching(candidate.query);
      const entry = index[folded];
      if (!entry || this.now() - entry.at > NAME_CACHE_MS) {
        unknownQueries.push(candidate.query);
        continue;
      }
      if (!entry.digits) continue;

      const existing = await this.store.getCompany(entry.digits);
      if (existing && existing.deletedAt === 0) {
        const updated = await this.corroborate(existing, receiptText);
        const match = matchCompanyName(updated.name, receiptText);
        return { status: 'cached', company: updated, score: match.score };
      }

      const byNumber = await this.resolveCompany(entry.digits, {
        receiptText,
        signal: options.signal,
      });
      if (byNumber.status !== 'skipped') {
        const match = matchCompanyName(byNumber.company.name, receiptText);
        return { status: byNumber.status, company: byNumber.company, score: match.score };
      }
    }

    if (unknownQueries.length === 0) {
      return { status: 'skipped', reason: 'not-found' };
    }

    const credentials = await this.getCredentials();
    const apiKey = credentials.apiKey.trim();
    if (!apiKey || !credentials.nameSearchEnabled) {
      return { status: 'skipped', reason: 'not-configured' };
    }

    let lastFailure: CompanyLookupFailure = 'not-found';

    for (const query of unknownQueries) {
      if (!(await this.spendSearch(credentials.dailySearchBudget))) {
        return { status: 'skipped', reason: 'budget-spent' };
      }

      this.logger.debug('apiverket.search.start', {
        query,
        apiKey: redactApiKey(apiKey),
      });

      let hits: CompanySearchHit[];
      try {
        hits = await this.client.searchCompanies(query, {
          apiKey,
          baseUrl: credentials.baseUrl,
          signal: options.signal,
        });
      } catch (error) {
        lastFailure = error instanceof CompanyLookupError ? error.failure : 'unavailable';
        if (lastFailure === 'not-found') await this.rememberName(query, null);
        this.logger.warn('apiverket.search.failed', {
          query,
          reason: lastFailure,
          apiKey: redactApiKey(apiKey),
        });
        continue;
      }

      const best = this.pickHit(hits, receiptText);
      if (!best) {
        await this.rememberName(query, null);
        continue;
      }

      await this.rememberName(query, best.digits);
      const byNumber = await this.resolveCompany(best.digits, {
        receiptText,
        signal: options.signal,
      });
      if (byNumber.status === 'skipped') {
        lastFailure = byNumber.reason;
        continue;
      }
      return { status: byNumber.status, company: byNumber.company, score: best.score };
    }

    return { status: 'skipped', reason: lastFailure };
  }

  async searchBudgetUsed(): Promise<number> {
    const today = localDay(this.now());
    const budget = await this.store.getKv<SearchBudget>(SEARCH_BUDGET_KEY, {
      day: today,
      used: 0,
    });
    return budget.day === today ? budget.used : 0;
  }

  async clearCaches(): Promise<void> {
    await this.store.setKv<MissCache>(MISSES_KEY, {});
    await this.store.setKv<NameIndex>(NAME_INDEX_KEY, {});
  }

  private async corroborate(company: StoredCompany, receiptText?: string): Promise<StoredCompany> {
    if (!receiptText) return company;
    const match = matchCompanyName(company.name, receiptText);
    if (match.score <= (company.nameMatchScore ?? 0)) return company;

    const updated: StoredCompany = {
      ...company,
      nameMatchScore: match.score,
      nameConfirmed: company.nameConfirmed || match.confirmed,
      updatedAt: this.now(),
    };

    await this.store.putCompany(updated);
    return updated;
  }

  private pickHit(hits: CompanySearchHit[], receiptText: string): { digits: string; score: number } | null {
    let best: { digits: string; score: number } | null = null;

    for (const hit of hits) {
      const match = matchCompanyName(hit.name, receiptText);
      if (match.score < NAME_MATCH_THRESHOLD) continue;
      const weighted = match.score + (hit.active === false ? -0.05 : 0);
      if (!best || weighted > best.score) {
        best = { digits: hit.digits, score: match.score };
      }
    }

    return best;
  }

  private async spendSearch(limit: number): Promise<boolean> {
    const today = localDay(this.now());
    const budget = await this.store.getKv<SearchBudget>(SEARCH_BUDGET_KEY, { day: today, used: 0 });
    const used = budget.day === today ? budget.used : 0;
    const max = Math.max(0, limit);

    if (used >= max) return false;
    await this.store.setKv<SearchBudget>(SEARCH_BUDGET_KEY, {
      day: today,
      used: used + 1,
    });
    return true;
  }

  private async isKnownMiss(digits: string): Promise<boolean> {
    const misses = await this.store.getKv<MissCache>(MISSES_KEY, {});
    const at = misses[digits];
    if (at === undefined) return false;

    if (this.now() - at < NEGATIVE_CACHE_MS) return true;

    delete misses[digits];
    await this.store.setKv<MissCache>(MISSES_KEY, misses);
    return false;
  }

  private async rememberMiss(digits: string): Promise<void> {
    const misses = await this.store.getKv<MissCache>(MISSES_KEY, {});
    misses[digits] = this.now();
    await this.store.setKv<MissCache>(MISSES_KEY, misses);
  }

  private async rememberName(query: string, digits: string | null): Promise<void> {
    const index = await this.store.getKv<NameIndex>(NAME_INDEX_KEY, {});
    index[foldForMatching(query)] = { digits, at: this.now() };
    await this.store.setKv<NameIndex>(NAME_INDEX_KEY, index);
  }
}
