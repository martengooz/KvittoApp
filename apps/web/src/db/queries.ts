/**
 * Read-side queries for the list views.
 *
 * Filtering and sorting happen in memory after an index-assisted fetch of the
 * live rows (`deletedAt === 0`). A personal receipt archive is thousands of
 * rows, not millions, so this is instant — and it buys arbitrary multi-criteria
 * filtering that would otherwise need a compound index per combination.
 */

import { tokenizeQuery, type Category, type ID, type Receipt, type ReceiptItem, type Tag } from '@kvitto/shared';
import { db } from './db.js';

export type ReceiptSortKey = 'date' | 'total' | 'merchant' | 'added' | 'items';
export type ItemSortKey = 'date' | 'name' | 'price' | 'unitPrice' | 'quantity' | 'merchant';
export type SortDirection = 'asc' | 'desc';

export interface ReceiptFilter {
  /** Free text matched against merchant, notes, receipt number and item names. */
  query?: string;
  /** Inclusive `YYYY-MM-DD` bounds on `purchasedAt`. */
  from?: string;
  to?: string;
  categoryIds?: ID[];
  /** Receipts must carry *every* listed tag. */
  tagIds?: ID[];
  statuses?: Receipt['status'][];
  minTotal?: number;
  maxTotal?: number;
  /** Only receipts whose extraction produced warnings, for a review queue. */
  needsReview?: boolean;
  sort?: ReceiptSortKey;
  direction?: SortDirection;
}

export interface ItemFilter {
  query?: string;
  from?: string;
  to?: string;
  categoryIds?: ID[];
  tagIds?: ID[];
  merchants?: string[];
  minPrice?: number;
  maxPrice?: number;
  /** Discount and pant rows are noise in most views, so they are off by default. */
  includeDiscounts?: boolean;
  includeDeposits?: boolean;
  sort?: ItemSortKey;
  direction?: SortDirection;
}

/** A line item joined with the bits of its receipt the purchases view shows. */
export interface PurchaseRow {
  item: ReceiptItem;
  receiptId: ID;
  merchantName: string | null;
  purchasedAt: string | null;
  currency: string;
}

export interface ReceiptBundle {
  receipt: Receipt;
  items: ReceiptItem[];
  tags: Tag[];
}

// --- primitive fetches ----------------------------------------------------

export function liveReceipts(): Promise<Receipt[]> {
  return db.receipts.where('deletedAt').equals(0).toArray();
}

export function liveItems(): Promise<ReceiptItem[]> {
  return db.items.where('deletedAt').equals(0).toArray();
}

export function liveCategories(): Promise<Category[]> {
  return db.categories.where('deletedAt').equals(0).toArray();
}

export function liveTags(): Promise<Tag[]> {
  return db.tags.where('deletedAt').equals(0).toArray();
}

export async function categoriesById(): Promise<Map<ID, Category>> {
  const rows = await liveCategories();
  return new Map(rows.map((row) => [row.id, row]));
}

export async function tagsById(): Promise<Map<ID, Tag>> {
  const rows = await liveTags();
  return new Map(rows.map((row) => [row.id, row]));
}

/** Tag ids per receipt, for list badges and tag filtering. */
export async function tagIdsByReceipt(): Promise<Map<ID, ID[]>> {
  const map = new Map<ID, ID[]>();
  const links = await db.receiptTags.where('deletedAt').equals(0).toArray();
  for (const link of links) {
    const list = map.get(link.receiptId);
    if (list) list.push(link.tagId);
    else map.set(link.receiptId, [link.tagId]);
  }
  return map;
}

export async function getReceiptBundle(id: ID): Promise<ReceiptBundle | null> {
  const receipt = await db.receipts.get(id);
  if (!receipt || receipt.deletedAt !== 0) return null;

  const items = (await db.items.where('[receiptId+deletedAt]').equals([id, 0]).toArray()).sort(
    (a, b) => a.lineNo - b.lineNo,
  );

  const links = await db.receiptTags.where('receiptId').equals(id).toArray();
  const liveTagIds = links.filter((link) => link.deletedAt === 0).map((link) => link.tagId);
  const allTags = await tagsById();
  const tags = liveTagIds
    .map((tagId) => allTags.get(tagId))
    .filter((tag): tag is Tag => tag !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name, 'sv'));

  return { receipt, items, tags };
}

// --- receipts -------------------------------------------------------------

export async function searchReceipts(filter: ReceiptFilter): Promise<Receipt[]> {
  const [receipts, tagMap] = await Promise.all([liveReceipts(), tagIdsByReceipt()]);

  const terms = filter.query ? tokenizeQuery(filter.query) : [];
  // Free-text search reaches into line items, so "mjölk" finds the receipt that
  // contains it even though the word appears nowhere on the receipt record.
  const receiptIdsMatchingItems = terms.length > 0 ? await receiptIdsForTerms(terms) : null;

  const wantedCategories = toSet(filter.categoryIds);
  const wantedTags = filter.tagIds ?? [];
  const wantedStatuses = toSet(filter.statuses);

  const matched = receipts.filter((receipt) => {
    if (wantedStatuses && !wantedStatuses.has(receipt.status)) return false;
    if (wantedCategories && (receipt.categoryId === null || !wantedCategories.has(receipt.categoryId))) {
      return false;
    }
    if (wantedTags.length > 0) {
      const own = tagMap.get(receipt.id) ?? [];
      if (!wantedTags.every((tagId) => own.includes(tagId))) return false;
    }
    if (!withinDate(receipt.purchasedAt, filter.from, filter.to)) return false;
    if (filter.minTotal !== undefined && (receipt.total ?? 0) < filter.minTotal) return false;
    if (filter.maxTotal !== undefined && (receipt.total ?? 0) > filter.maxTotal) return false;
    if (filter.needsReview && !receiptNeedsReview(receipt)) return false;

    if (terms.length > 0) {
      const haystack = receiptHaystack(receipt);
      const hitsReceipt = terms.every((term) => haystack.includes(term));
      const hitsItems = receiptIdsMatchingItems?.has(receipt.id) ?? false;
      if (!hitsReceipt && !hitsItems) return false;
    }
    return true;
  });

  return sortReceipts(matched, filter.sort ?? 'date', filter.direction ?? 'desc');
}

/** A receipt worth a second look: failed, or parsed with warnings. */
export function receiptNeedsReview(receipt: Receipt): boolean {
  if (receipt.status === 'failed') return true;
  if (receipt.status === 'confirmed') return false;
  return (receipt.extraction?.warnings.length ?? 0) > 0;
}

async function receiptIdsForTerms(terms: string[]): Promise<Set<ID>> {
  const ids = new Set<ID>();
  const items = await liveItems();
  for (const item of items) {
    if (terms.some((term) => item.searchName.includes(term))) ids.add(item.receiptId);
  }
  return ids;
}

function receiptHaystack(receipt: Receipt): string {
  return [
    receipt.merchant.name,
    receipt.merchant.city,
    receipt.notes,
    receipt.receiptNumber,
    receipt.paymentMethod,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortReceipts(rows: Receipt[], key: ReceiptSortKey, direction: SortDirection): Receipt[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (key) {
      case 'total':
        return sign * ((a.total ?? 0) - (b.total ?? 0));
      case 'merchant':
        return sign * (a.merchant.name ?? '').localeCompare(b.merchant.name ?? '', 'sv');
      case 'added':
        return sign * (a.updatedAt - b.updatedAt);
      case 'items':
        return sign * (a.itemCount - b.itemCount);
      case 'date':
      default:
        // Undated receipts sort last in both directions: they are incomplete,
        // not "very old", so burying them at the end is the useful behaviour.
        if (!a.purchasedAt && !b.purchasedAt) return b.updatedAt - a.updatedAt;
        if (!a.purchasedAt) return 1;
        if (!b.purchasedAt) return -1;
        return sign * a.purchasedAt.localeCompare(b.purchasedAt);
    }
  });
}

// --- purchases (line items across every receipt) --------------------------

export async function searchPurchases(filter: ItemFilter): Promise<PurchaseRow[]> {
  const [items, receipts, tagMap] = await Promise.all([
    liveItems(),
    liveReceipts(),
    filter.tagIds?.length ? tagIdsByReceipt() : Promise.resolve(new Map<ID, ID[]>()),
  ]);

  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const terms = filter.query ? tokenizeQuery(filter.query) : [];
  const wantedCategories = toSet(filter.categoryIds);
  const wantedMerchants = toSet(filter.merchants?.map((name) => name.toLowerCase()));
  const wantedTags = filter.tagIds ?? [];

  const rows: PurchaseRow[] = [];
  for (const item of items) {
    if (!filter.includeDiscounts && item.isDiscount) continue;
    if (!filter.includeDeposits && item.isDeposit) continue;

    const receipt = receiptById.get(item.receiptId);
    // Items whose receipt is gone are orphans from a partial sync; hide them.
    if (!receipt) continue;

    if (wantedCategories && (item.categoryId === null || !wantedCategories.has(item.categoryId))) continue;
    if (!withinDate(receipt.purchasedAt, filter.from, filter.to)) continue;
    if (filter.minPrice !== undefined && item.totalPrice < filter.minPrice) continue;
    if (filter.maxPrice !== undefined && item.totalPrice > filter.maxPrice) continue;

    if (wantedMerchants) {
      const name = receipt.merchant.name?.toLowerCase() ?? '';
      if (!wantedMerchants.has(name)) continue;
    }
    if (wantedTags.length > 0) {
      const own = tagMap.get(receipt.id) ?? [];
      if (!wantedTags.every((tagId) => own.includes(tagId))) continue;
    }
    if (terms.length > 0) {
      const haystack = `${item.searchName} ${receipt.merchant.name?.toLowerCase() ?? ''}`;
      if (!terms.every((term) => haystack.includes(term))) continue;
    }

    rows.push({
      item,
      receiptId: receipt.id,
      merchantName: receipt.merchant.name,
      purchasedAt: receipt.purchasedAt,
      currency: receipt.currency,
    });
  }

  return sortPurchases(rows, filter.sort ?? 'date', filter.direction ?? 'desc');
}

function sortPurchases(rows: PurchaseRow[], key: ItemSortKey, direction: SortDirection): PurchaseRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (key) {
      case 'name':
        return sign * a.item.name.localeCompare(b.item.name, 'sv');
      case 'price':
        return sign * (a.item.totalPrice - b.item.totalPrice);
      case 'unitPrice':
        return sign * ((a.item.unitPrice ?? 0) - (b.item.unitPrice ?? 0));
      case 'quantity':
        return sign * (a.item.quantity - b.item.quantity);
      case 'merchant':
        return sign * (a.merchantName ?? '').localeCompare(b.merchantName ?? '', 'sv');
      case 'date':
      default: {
        if (!a.purchasedAt && !b.purchasedAt) return a.item.name.localeCompare(b.item.name, 'sv');
        if (!a.purchasedAt) return 1;
        if (!b.purchasedAt) return -1;
        const byDate = sign * a.purchasedAt.localeCompare(b.purchasedAt);
        // Keep a single receipt's lines in printed order within the same day.
        return byDate !== 0 ? byDate : a.item.lineNo - b.item.lineNo;
      }
    }
  });
}

// --- aggregates -----------------------------------------------------------

export interface SpendSummary {
  receiptCount: number;
  itemCount: number;
  total: number;
  /** Total per `YYYY-MM`, oldest first. */
  byMonth: { month: string; total: number; receipts: number }[];
  byCategory: { categoryId: ID | null; total: number; count: number }[];
  byMerchant: { merchant: string; total: number; receipts: number }[];
}

export async function summarize(filter: ReceiptFilter = {}): Promise<SpendSummary> {
  const receipts = await searchReceipts(filter);
  const receiptIds = new Set(receipts.map((receipt) => receipt.id));
  const items = (await liveItems()).filter((item) => receiptIds.has(item.receiptId));

  const monthTotals = new Map<string, { total: number; receipts: number }>();
  const merchantTotals = new Map<string, { total: number; receipts: number }>();
  let total = 0;

  for (const receipt of receipts) {
    total += receipt.total ?? 0;

    const month = receipt.purchasedAt?.slice(0, 7) ?? 'okänt';
    const monthEntry = monthTotals.get(month) ?? { total: 0, receipts: 0 };
    monthEntry.total += receipt.total ?? 0;
    monthEntry.receipts += 1;
    monthTotals.set(month, monthEntry);

    const merchant = receipt.merchant.name ?? 'Okänd butik';
    const merchantEntry = merchantTotals.get(merchant) ?? { total: 0, receipts: 0 };
    merchantEntry.total += receipt.total ?? 0;
    merchantEntry.receipts += 1;
    merchantTotals.set(merchant, merchantEntry);
  }

  const categoryTotals = new Map<ID | null, { total: number; count: number }>();
  for (const item of items) {
    if (item.isDiscount || item.isDeposit) continue;
    const entry = categoryTotals.get(item.categoryId) ?? { total: 0, count: 0 };
    entry.total += item.totalPrice;
    entry.count += 1;
    categoryTotals.set(item.categoryId, entry);
  }

  return {
    receiptCount: receipts.length,
    itemCount: items.length,
    total: Math.round(total * 100) / 100,
    byMonth: [...monthTotals.entries()]
      .map(([month, value]) => ({ month, ...value }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    byCategory: [...categoryTotals.entries()]
      .map(([categoryId, value]) => ({ categoryId, ...value }))
      .sort((a, b) => b.total - a.total),
    byMerchant: [...merchantTotals.entries()]
      .map(([merchant, value]) => ({ merchant, ...value }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Distinct merchant names, for the filter dropdown. */
export async function knownMerchants(): Promise<string[]> {
  const names = new Set<string>();
  const receipts = await liveReceipts();
  for (const receipt of receipts) {
    if (receipt.merchant.name) names.add(receipt.merchant.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'sv'));
}

/** Price history for one product name, so the detail view can show a trend. */
export async function priceHistory(searchName: string): Promise<PurchaseRow[]> {
  const rows = await searchPurchases({ query: `"${searchName}"`, sort: 'date', direction: 'asc' });
  return rows.filter((row) => row.item.searchName === searchName);
}

// --- helpers --------------------------------------------------------------

function toSet<T>(values: T[] | undefined): Set<T> | null {
  return values && values.length > 0 ? new Set(values) : null;
}

/** Inclusive date-range test against a naive local ISO string. */
function withinDate(value: string | null, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  const day = value.slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}
