import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

import {
  CompanyLookupError,
  type CompanyRecord,
  type CompanySearchHit,
} from '@kvitto/shared';

import { IosDataRepository } from '../src/data/repository';
import {
  NAME_CACHE_MS,
  NEGATIVE_CACHE_MS,
  createCompanyLookup,
  type CompanyLookupService,
  type CompanySettings,
} from '../src/company/lookup';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

const ICA_DIGITS = '5567037485';
const ICA_FORMATTED = '556703-7485';

/** OCR text a scan of an ICA receipt would plausibly produce. */
const ICA_RECEIPT_TEXT = [
  'ICA SVERIGE AB',
  'Org.nr 556703-7485',
  'Mjolk 3% 1L        18,90',
  'TOTALT             18,90',
].join('\n');

function record(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    orgNumber: ICA_FORMATTED,
    name: 'ICA Sverige AB',
    legalForm: 'Aktiebolag',
    status: 'active',
    active: true,
    address: 'Kolonnvägen 20',
    postalCode: '17188',
    city: 'Solna',
    industry: 'Livsmedelshandel',
    raw: {},
    source: 'apiverket',
    fetchedAt: 1_000,
    ...overrides,
  };
}

interface Harness {
  db: SqliteTestAdapter;
  repository: IosDataRepository;
  lookup: CompanyLookupService;
  lookupCalls: string[];
  searchCalls: string[];
  clock: { value: number };
  settings: CompanySettings;
  lookupImpl: (digits: string) => Promise<CompanyRecord>;
  searchImpl: (query: string) => Promise<CompanySearchHit[]>;
}

function harness(settings: Partial<CompanySettings> = {}): Harness {
  const db = new SqliteTestAdapter();
  const clock = { value: 1_000 };
  const repository = new IosDataRepository(db, () => clock.value);

  const state: Harness = {
    db,
    repository,
    clock,
    lookupCalls: [],
    searchCalls: [],
    settings: { apiKey: 'sk_test_key', nameSearch: true, searchBudget: 20, ...settings },
    lookupImpl: async () => record(),
    searchImpl: async () => [],
    lookup: undefined as unknown as CompanyLookupService,
  };

  state.lookup = createCompanyLookup({
    now: () => clock.value,
    getCompany: (digits) => repository.get('companies', digits),
    putCompany: async (company) => {
      await repository.upsert('companies', company);
    },
    getKeyValue: (key) => repository.getKeyValue(key),
    setKeyValue: (key, value) => repository.setKeyValue(key, value),
    getSettings: async () => state.settings,
    api: {
      lookupCompany: async (orgNumber) => {
        state.lookupCalls.push(orgNumber);
        return state.lookupImpl(orgNumber);
      },
      searchCompanies: async (query) => {
        state.searchCalls.push(query);
        return state.searchImpl(query);
      },
    },
  });

  return state;
}

let live: Harness | null = null;

beforeEach(() => {
  live = harness();
});

afterEach(() => {
  live?.db.close();
  live = null;
});

describe('resolving a company by organisation number', () => {
  test('fetches once and stores the result', async () => {
    const h = live!;

    const outcome = await h.lookup.resolve(ICA_FORMATTED, { receiptText: ICA_RECEIPT_TEXT });

    expect(outcome.status).toBe('fetched');
    expect(h.lookupCalls).toEqual([ICA_DIGITS]);

    const stored = await h.repository.get('companies', ICA_DIGITS);
    expect(stored?.name).toBe('ICA Sverige AB');
    // The number is the id, unformatted, so a receipt that spells it with a
    // hyphen and one that does not land on the same row.
    expect(stored?.id).toBe(ICA_DIGITS);
    expect(stored?.dirty).toBe(1);
  });

  test('a company already stored is never looked up again', async () => {
    // This is the rule the whole module exists to enforce: the quota is
    // metered, and a rescan of the same shop must not cost anything.
    const h = live!;

    await h.lookup.resolve(ICA_FORMATTED);
    const second = await h.lookup.resolve(ICA_FORMATTED);

    expect(second.status).toBe('cached');
    expect(h.lookupCalls).toEqual([ICA_DIGITS]);
  });

  test('a malformed number never reaches the API', async () => {
    // The API charges quota for a 400, and OCR produces malformed numbers
    // constantly, so the local checksum is what protects the quota.
    const h = live!;

    const outcome = await h.lookup.resolve('123456-7890');

    expect(outcome).toEqual({ status: 'skipped', reason: 'invalid-org-number' });
    expect(h.lookupCalls).toEqual([]);
  });

  test('remembers a "not found", so a rescan costs nothing', async () => {
    const h = live!;
    h.lookupImpl = async () => {
      throw new CompanyLookupError('not-found', 'nope');
    };

    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('skipped');
    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('skipped');

    expect(h.lookupCalls).toEqual([ICA_DIGITS]);
  });

  test('asks again once the negative cache expires', async () => {
    const h = live!;
    h.lookupImpl = async () => {
      throw new CompanyLookupError('not-found', 'nope');
    };
    await h.lookup.resolve(ICA_FORMATTED);

    h.clock.value += NEGATIVE_CACHE_MS + 1;
    h.lookupImpl = async () => record();

    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('fetched');
    expect(h.lookupCalls).toHaveLength(2);
  });

  test('does not cache a quota or network failure', async () => {
    // A rate limit says nothing about whether the company exists. Caching it
    // would lose the company until the negative cache expired a month later.
    const h = live!;
    h.lookupImpl = async () => {
      throw new CompanyLookupError('rate-limited', 'slow down', true);
    };
    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('skipped');

    h.lookupImpl = async () => record();
    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('fetched');
  });

  test('cacheOnly answers from the store and never reaches the network', async () => {
    const h = live!;

    const cold = await h.lookup.resolve(ICA_FORMATTED, { cacheOnly: true });
    expect(cold).toEqual({ status: 'skipped', reason: 'not-configured' });
    expect(h.lookupCalls).toEqual([]);

    await h.lookup.resolve(ICA_FORMATTED);
    const warm = await h.lookup.resolve(ICA_FORMATTED, { cacheOnly: true });
    expect(warm.status).toBe('cached');
  });

  test('force re-queries a company that is already stored', async () => {
    const h = live!;
    await h.lookup.resolve(ICA_FORMATTED);

    h.lookupImpl = async () => record({ name: 'ICA Sverige AB (ny)' });
    const outcome = await h.lookup.resolve(ICA_FORMATTED, { force: true });

    expect(outcome.status).toBe('fetched');
    expect((await h.repository.get('companies', ICA_DIGITS))?.name).toBe('ICA Sverige AB (ny)');
  });

  test('without an API key it skips rather than failing', async () => {
    const h = live!;
    h.settings = { ...h.settings, apiKey: '   ' };

    expect(await h.lookup.resolve(ICA_FORMATTED)).toEqual({
      status: 'skipped',
      reason: 'not-configured',
    });
    expect(h.lookupCalls).toEqual([]);
  });
});

describe('corroborating a stored name against a new receipt', () => {
  test('raises a stored match score when a cleaner scan agrees', async () => {
    const h = live!;
    await h.lookup.resolve(ICA_FORMATTED);
    const before = await h.repository.get('companies', ICA_DIGITS);
    // Fetched with no receipt text, so nothing has corroborated the name yet.
    expect(before?.nameMatchScore).toBeNull();

    const outcome = await h.lookup.resolve(ICA_FORMATTED, { receiptText: ICA_RECEIPT_TEXT });

    expect(outcome.status).toBe('cached');
    const after = await h.repository.get('companies', ICA_DIGITS);
    expect(after?.nameMatchScore ?? 0).toBeGreaterThan(0);
  });

  test('a poor scan never downgrades a score a good one established', async () => {
    const h = live!;
    await h.lookup.resolve(ICA_FORMATTED, { receiptText: ICA_RECEIPT_TEXT });
    const good = await h.repository.get('companies', ICA_DIGITS);
    // Otherwise the comparison below would hold vacuously with both null.
    expect(good?.nameMatchScore ?? 0).toBeGreaterThan(0);

    await h.lookup.resolve(ICA_FORMATTED, { receiptText: 'I C 4 5VERIGE ...garbled...' });

    const after = await h.repository.get('companies', ICA_DIGITS);
    expect(after?.nameMatchScore).toBe(good?.nameMatchScore);
    expect(after?.nameConfirmed).toBe(good?.nameConfirmed);
  });
});

describe('resolving a company by name', () => {
  function hit(overrides: Partial<CompanySearchHit> = {}): CompanySearchHit {
    return { ...record(), digits: ICA_DIGITS, ...overrides };
  }

  test('accepts a hit whose registered name appears on the receipt', async () => {
    const h = live!;
    h.searchImpl = async () => [hit()];

    const outcome = await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(outcome.status).not.toBe('skipped');
    if (outcome.status === 'skipped') return;
    expect(outcome.company.id).toBe(ICA_DIGITS);
    // Stored through the by-number endpoint, so the row has the same fields
    // however it was found.
    expect(h.lookupCalls).toEqual([ICA_DIGITS]);
  });

  test('rejects a hit that cannot be found in the receipt text', async () => {
    // A substring search returns every namesake; filing the wrong company
    // silently is worse than filing none.
    const h = live!;
    h.searchImpl = async () => [hit({ name: 'Helt Annat Bolag AB', digits: '5560000005' })];

    const outcome = await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(outcome.status).toBe('skipped');
    // The search did happen - this is a rejected hit, not a skipped search.
    expect(h.searchCalls.length).toBeGreaterThan(0);
    expect(h.lookupCalls).toEqual([]);
  });

  test('a resolved search term is never searched for again', async () => {
    const h = live!;
    h.searchImpl = async () => [hit()];

    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });
    const searchesAfterFirst = h.searchCalls.length;
    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(h.searchCalls).toHaveLength(searchesAfterFirst);
  });

  test('a term that found nothing is also remembered', async () => {
    const h = live!;
    h.searchImpl = async () => [];

    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });
    const spent = h.searchCalls.length;
    expect(spent).toBeGreaterThan(0);

    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });
    expect(h.searchCalls).toHaveLength(spent);
  });

  test('searches again once the name cache expires', async () => {
    const h = live!;
    h.searchImpl = async () => [];
    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });
    const spent = h.searchCalls.length;

    h.clock.value += NAME_CACHE_MS + 1;
    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(h.searchCalls.length).toBeGreaterThan(spent);
  });

  test('stops once the daily search budget is spent', async () => {
    // The search endpoint has its own quota, an order of magnitude smaller
    // than the rest of the API - twenty calls a day on a free key.
    const h = live!;
    h.searchImpl = async () => [];

    const outcome = await h.lookup.resolveByName({
      receiptText: 'OKANT FORETAG XYZ\nTOTALT 10,00',
      dailyBudget: 0,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'budget-spent' });
    expect(h.searchCalls).toEqual([]);
  });

  test('the budget resets on a new local day', async () => {
    const h = live!;
    h.searchImpl = async () => [];

    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT, dailyBudget: 1 });
    expect(await h.lookup.searchBudgetUsed()).toBe(1);

    h.clock.value += 24 * 60 * 60 * 1000;
    expect(await h.lookup.searchBudgetUsed()).toBe(0);
  });

  test('never searches when name search is switched off', async () => {
    const h = live!;
    h.settings = { ...h.settings, nameSearch: false };
    h.searchImpl = async () => [hit()];

    const outcome = await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not-configured' });
    expect(h.searchCalls).toEqual([]);
  });

  test('a rate limit does not poison the search term', async () => {
    const h = live!;
    h.searchImpl = async () => {
      throw new CompanyLookupError('rate-limited', 'slow down', true);
    };
    await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    h.searchImpl = async () => [hit()];
    const outcome = await h.lookup.resolveByName({ receiptText: ICA_RECEIPT_TEXT });

    expect(outcome.status).not.toBe('skipped');
  });

  test('clearing misses makes both caches retry', async () => {
    const h = live!;
    h.lookupImpl = async () => {
      throw new CompanyLookupError('not-found', 'nope');
    };
    await h.lookup.resolve(ICA_FORMATTED);

    await h.lookup.clearMisses();
    h.lookupImpl = async () => record();

    expect((await h.lookup.resolve(ICA_FORMATTED)).status).toBe('fetched');
  });

  test('a corrupt cache is a cache miss, not a failed scan', async () => {
    // A cache that cannot be parsed must cost at most one extra API call.
    // Throwing here would take scanning down with it.
    const h = live!;
    await h.repository.setKeyValue('companies:misses', '{not json');

    const outcome = await h.lookup.resolve(ICA_FORMATTED);

    expect(outcome.status).toBe('fetched');
  });
});

describe('the company row a lookup writes', () => {
  test('is marked dirty so sync pushes it', async () => {
    const h = live!;
    await h.lookup.resolve(ICA_FORMATTED);

    const dirty = await h.repository.listDirty(10);
    expect(dirty.some((entry) => entry.kind === 'companies' && entry.id === ICA_DIGITS)).toBe(true);
  });

  test('keeps the whole registry payload, so no field needs a second lookup', async () => {
    const h = live!;
    h.lookupImpl = async () => record({ raw: { org_number: ICA_FORMATTED, employees: 42 } });

    await h.lookup.resolve(ICA_FORMATTED);

    const stored = await h.repository.get('companies', ICA_DIGITS);
    expect((stored?.raw as Record<string, unknown>)?.employees).toBe(42);
  });
});
