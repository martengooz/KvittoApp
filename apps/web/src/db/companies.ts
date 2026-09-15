/**
 * The company store: plain reads and writes over the `companies` table.
 *
 * The cache-first registry lookup and its daily search-budget policy — the
 * code that decides *whether* to fetch a company and pays for it — live in
 * `company/lookup.ts` instead. That code reaches into `core/settings` and
 * `api/apiverket`; this file does not, so it stays a `db/` module in fact and
 * not just in name.
 */

import { checkOrgNumber, newId, EMPTY_SYNC_META, type Company, type ID } from '@kvitto/shared';

import { bus } from '../core/events.js';
import type { CompanyRecord } from '../api/apiverket.js';
import { db } from './db.js';

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
