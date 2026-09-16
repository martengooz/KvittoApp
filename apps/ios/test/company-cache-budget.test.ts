import { describe, expect, test } from '@jest/globals';

import {
  ApiverketLookupController,
  CompanyLookupError,
  type CompanyCacheStore,
  type CompanyRecord,
  type CompanyRegistryClient,
  type CompanySearchHit,
  type StoredCompany,
} from '../src/company/apiverket-controller';

class MemoryStore implements CompanyCacheStore {
  private readonly companies = new Map<string, StoredCompany>();
  private readonly kv = new Map<string, unknown>();

  async getCompany(id: string): Promise<StoredCompany | null> {
    return this.companies.get(id) ?? null;
  }

  async putCompany(company: StoredCompany): Promise<void> {
    this.companies.set(company.id, company);
  }

  async getKv<T>(key: string, fallback: T): Promise<T> {
    return (this.kv.get(key) as T | undefined) ?? fallback;
  }

  async setKv<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }
}

function record(orgNumber: string, name: string): CompanyRecord {
  return {
    orgNumber,
    name,
    legalForm: 'Aktiebolag',
    status: 'active',
    active: true,
    address: 'Storgatan 1',
    postalCode: '11122',
    city: 'Stockholm',
    industry: 'Handel',
    raw: { org_number: orgNumber, name },
    source: 'apiverket',
    fetchedAt: 1700000000000,
  };
}

class ClientStub implements CompanyRegistryClient {
  public lookupCalls = 0;
  public searchCalls = 0;

  async lookupCompany(digits: string): Promise<CompanyRecord> {
    this.lookupCalls += 1;
    return record(`${digits.slice(0, 6)}-${digits.slice(6)}`, digits === '5560160680' ? 'Bauhaus AB' : 'ICA Maxi AB');
  }

  async searchCompanies(query: string): Promise<CompanySearchHit[]> {
    this.searchCalls += 1;
    if (query.toLowerCase().includes('unknown')) {
      throw new CompanyLookupError('not-found', 'no company');
    }
    return [
      {
        ...record('556016-0680', 'Bauhaus AB'),
        digits: '5560160680',
      },
    ];
  }
}

describe('company cache and budget controller', () => {
  test('uses cache before network for org number lookups', async () => {
    const store = new MemoryStore();
    const client = new ClientStub();
    const now = () => 1700000000000;

    const controller = new ApiverketLookupController({
      store,
      client,
      now,
      getCredentials: () => ({
        apiKey: 'sk_live_12345678',
        nameSearchEnabled: true,
        dailySearchBudget: 2,
      }),
    });

    const first = await controller.resolveCompany('556016-0680', {
      receiptText: 'BAUHAUS Varmdo 2026-09-16',
    });
    expect(first.status).toBe('fetched');
    expect(client.lookupCalls).toBe(1);

    const second = await controller.resolveCompany('556016-0680', {
      receiptText: 'BAUHAUS Varmdo 2026-09-16',
    });
    expect(second.status).toBe('cached');
    expect(client.lookupCalls).toBe(1);
  });

  test('applies daily budget to fuzzy name search and caches the hit', async () => {
    const store = new MemoryStore();
    const client = new ClientStub();

    const controller = new ApiverketLookupController({
      store,
      client,
      now: () => 1700000000000,
      getCredentials: () => ({
        apiKey: 'sk_live_abcdefgh',
        nameSearchEnabled: true,
        dailySearchBudget: 1,
      }),
    });

    const receiptText = [
      'BAUHAUS',
      'Nacka Forum',
      'Totalt 100,00',
      'Org.nr saknas',
    ].join('\n');

    const first = await controller.resolveCompanyByName(receiptText);
    expect(first.status).toBe('fetched');
    expect(client.searchCalls).toBe(1);

    const cached = await controller.resolveCompanyByName(receiptText);
    expect(cached.status).toBe('cached');
    expect(client.searchCalls).toBe(1);

    const denied = await controller.resolveCompanyByName('UNKNOWN RECEIPT\nTotalt 35,00');
    expect(denied).toEqual({ status: 'skipped', reason: 'budget-spent' });
  });
});
