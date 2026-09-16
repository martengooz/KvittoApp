/**
 * Write-side data access.
 *
 * Every mutation goes through here so two invariants always hold:
 * 1. `updatedAt` is refreshed and `dirty` is set, or the change never syncs.
 * 2. Deletes are tombstones, so they propagate to other devices.
 */

import {
  DEFAULT_CATEGORIES,
  EMPTY_SYNC_META,
  emptyMerchant,
  guessCategorySlug,
  newId,
  normalizeSearchName,
  seedCategoryId,
  type Category,
  type ID,
  type Merchant,
  type NormalizedExtraction,
  type Receipt,
  type ReceiptItem,
  type ReceiptSource,
  type ReceiptStatus,
  type SyncMeta,
  type Tag,
} from '@kvitto/shared';

import { bus } from '../core/events.js';
import { db, SYNC_TABLES } from './db.js';
import { releaseBlobUrl } from './blobs.js';

/** Fresh sync metadata for a record created on this device. */
function newMeta(): SyncMeta {
  return { ...EMPTY_SYNC_META, updatedAt: Date.now(), dirty: 1 };
}

/** Marks a record as locally modified. Every patch must go through this. */
function touch<T extends object>(patch: T): T & Pick<SyncMeta, 'updatedAt' | 'dirty'> {
  return { ...patch, updatedAt: Date.now(), dirty: 1 as const };
}

function announce(...kinds: string[]): void {
  bus.emit('data:changed', { kinds });
}

// --- receipts -------------------------------------------------------------

export interface CreateReceiptInput {
  source: ReceiptSource;
  imageId: string | null;
  originalImageId?: string | null;
  thumbId?: string | null;
  status?: ReceiptStatus;
}

export function blankReceipt(input: CreateReceiptInput): Receipt {
  return {
    ...newMeta(),
    id: newId(),
    merchant: emptyMerchant(),
    purchasedAt: null,
    currency: 'SEK',
    total: null,
    subtotal: null,
    discountTotal: null,
    roundingAmount: null,
    depositTotal: null,
    vatLines: [],
    paymentMethod: null,
    cardLast4: null,
    receiptNumber: null,
    terminalId: null,
    cashier: null,
    categoryId: null,
    companyId: null,
    notes: null,
    source: input.source,
    imageId: input.imageId,
    originalImageId: input.originalImageId ?? null,
    thumbId: input.thumbId ?? null,
    status: input.status ?? 'draft',
    extraction: null,
    ocr: null,
    itemCount: 0,
  };
}

export async function createReceipt(input: CreateReceiptInput): Promise<Receipt> {
  const receipt = blankReceipt(input);
  await db.receipts.put(receipt);
  announce('receipts');
  return receipt;
}

export async function updateReceipt(id: ID, patch: Partial<Receipt>): Promise<void> {
  await db.receipts.update(id, touch(patch));
  announce('receipts');
}

/**
 * Replaces a receipt's parsed data and line items with a fresh extraction.
 *
 * Existing items are tombstoned rather than removed so that re-running the AI
 * on a receipt that has already synced does not resurrect the old lines on
 * another device.
 */
export async function applyExtraction(
  receiptId: ID,
  extraction: NormalizedExtraction,
  provenance: NonNullable<Receipt['extraction']>,
): Promise<void> {
  const categoryBySlug = await slugToCategoryId();
  const before = await db.receipts.get(receiptId);

  await db.transaction('rw', db.receipts, db.items, async () => {
    const now = Date.now();
    const existing = await db.items.where('receiptId').equals(receiptId).toArray();
    for (const item of existing) {
      if (item.deletedAt !== 0) continue;
      await db.items.update(item.id, { deletedAt: now, updatedAt: now, dirty: 1 });
    }

    const items: ReceiptItem[] = extraction.items.map((source, index) => ({
      ...newMeta(),
      id: newId(),
      receiptId,
      lineNo: index,
      name: source.name,
      rawName: source.rawName,
      searchName: source.searchName,
      quantity: source.quantity,
      unit: source.unit,
      unitPrice: source.unitPrice,
      totalPrice: source.totalPrice,
      discount: source.discount,
      vatRate: source.vatRate,
      categoryId: categoryBySlug.get(guessCategorySlug(source.searchName) ?? '') ?? null,
      ean: source.ean,
      deposit: source.deposit,
      isDeposit: source.isDeposit,
      isDiscount: source.isDiscount,
      notes: null,
    }));
    if (items.length > 0) await db.items.bulkPut(items);

    await db.receipts.update(
      receiptId,
      touch({
        merchant: keepKnown(before?.merchant, extraction.merchant),
        purchasedAt: extraction.purchasedAt ?? before?.purchasedAt ?? null,
        currency: extraction.currency,
        total: extraction.total,
        subtotal: extraction.subtotal,
        discountTotal: extraction.discountTotal,
        roundingAmount: extraction.roundingAmount,
        depositTotal: extraction.depositTotal,
        vatLines: extraction.vatLines,
        paymentMethod: extraction.paymentMethod,
        cardLast4: extraction.cardLast4,
        receiptNumber: extraction.receiptNumber,
        terminalId: extraction.terminalId,
        cashier: extraction.cashier,
        status: 'parsed',
        extraction: provenance,
        itemCount: items.length,
      }),
    );
  });
  announce('receipts', 'items');
}

/**
 * Overlays a fresh merchant on what was already known, keeping a field the
 * model left blank.
 *
 * The two sources are not equivalent. The on-device OCR pass contributes a
 * checksum-verified organisation number and the registry name that number
 * resolved to; a model that simply did not read them returns `null`, which says
 * nothing. Letting that null win would throw away the better fact — and, on a
 * re-parse, a correction the user typed in by hand.
 */
function keepKnown(previous: Merchant | undefined, next: Merchant): Merchant {
  if (!previous) return next;
  const merged = { ...next };
  for (const key of Object.keys(merged) as (keyof Merchant)[]) {
    merged[key] ??= previous[key];
  }
  return merged;
}

/** Tombstones a receipt along with its items and tag links. */
export async function deleteReceipt(id: ID): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.receipts, db.items, db.receiptTags, async () => {
    await db.receipts.update(id, { deletedAt: now, updatedAt: now, dirty: 1 });
    const items = await db.items.where('receiptId').equals(id).primaryKeys();
    for (const itemId of items) {
      await db.items.update(itemId, { deletedAt: now, updatedAt: now, dirty: 1 });
    }
    const links = await db.receiptTags.where('receiptId').equals(id).primaryKeys();
    for (const linkId of links) {
      await db.receiptTags.update(linkId, { deletedAt: now, updatedAt: now, dirty: 1 });
    }
  });
  announce('receipts', 'items', 'receiptTags');
}

/** Undoes {@link deleteReceipt} while the tombstone is still around. */
export async function restoreReceipt(id: ID): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.receipts, db.items, db.receiptTags, async () => {
    await db.receipts.update(id, { deletedAt: 0, updatedAt: now, dirty: 1 });
    const items = await db.items.where('receiptId').equals(id).primaryKeys();
    for (const itemId of items) {
      await db.items.update(itemId, { deletedAt: 0, updatedAt: now, dirty: 1 });
    }
  });
  announce('receipts', 'items');
}

// --- items ----------------------------------------------------------------

export async function updateItem(id: ID, patch: Partial<ReceiptItem>): Promise<void> {
  const next = { ...patch };
  // Keep the search key in step whenever the display name changes.
  if (typeof next.name === 'string') next.searchName = normalizeSearchName(next.name);
  await db.items.update(id, touch(next));
  announce('items');
}

export async function addItem(receiptId: ID, partial: Partial<ReceiptItem> = {}): Promise<ReceiptItem> {
  const siblings = await db.items.where('receiptId').equals(receiptId).toArray();
  const lineNo = siblings.reduce((max, item) => Math.max(max, item.lineNo + 1), 0);
  const name = partial.name ?? 'Ny rad';

  const item: ReceiptItem = {
    ...newMeta(),
    id: newId(),
    receiptId,
    lineNo,
    name,
    rawName: null,
    searchName: normalizeSearchName(name),
    quantity: 1,
    unit: 'st',
    unitPrice: null,
    totalPrice: 0,
    discount: null,
    vatRate: null,
    categoryId: null,
    ean: null,
    deposit: null,
    isDeposit: false,
    isDiscount: false,
    notes: null,
    ...partial,
  };
  await db.items.put(item);
  await refreshItemCount(receiptId);
  announce('items', 'receipts');
  return item;
}

export async function deleteItem(id: ID): Promise<void> {
  const item = await db.items.get(id);
  if (!item) return;
  const now = Date.now();
  await db.items.update(id, { deletedAt: now, updatedAt: now, dirty: 1 });
  await refreshItemCount(item.receiptId);
  announce('items', 'receipts');
}

async function refreshItemCount(receiptId: ID): Promise<void> {
  const live = await db.items.where('[receiptId+deletedAt]').equals([receiptId, 0]).count();
  await db.receipts.update(receiptId, touch({ itemCount: live }));
}

// --- categories -----------------------------------------------------------

export async function seedDefaultCategoriesOnce(): Promise<void> {
  const alreadySeeded = await db.kv.get('categories:seeded');
  if (alreadySeeded) return;

  const now = Date.now();
  const rows: Category[] = DEFAULT_CATEGORIES.map((seed, index) => ({
    ...EMPTY_SYNC_META,
    updatedAt: now,
    dirty: 1,
    id: seedCategoryId(seed.slug),
    name: seed.name,
    color: seed.color,
    icon: seed.icon,
    parentId: null,
    scope: seed.scope,
    sortOrder: index,
  }));

  // `add` rather than `put`: if another tab seeded first, keep its rows.
  await db.transaction('rw', db.categories, db.kv, async () => {
    for (const row of rows) {
      const existing = await db.categories.get(row.id);
      if (!existing) await db.categories.add(row);
    }
    await db.kv.put({ key: 'categories:seeded', value: now });
  });
  announce('categories');
}

async function slugToCategoryId(): Promise<Map<string, ID>> {
  const map = new Map<string, ID>();
  for (const seed of DEFAULT_CATEGORIES) {
    const id = seedCategoryId(seed.slug);
    const row = await db.categories.get(id);
    if (row && row.deletedAt === 0) map.set(seed.slug, id);
  }
  return map;
}

export async function createCategory(partial: Partial<Category> & { name: string }): Promise<Category> {
  const count = await db.categories.count();
  const category: Category = {
    ...newMeta(),
    id: newId(),
    name: partial.name,
    color: partial.color ?? '#7f8c8d',
    icon: partial.icon ?? null,
    parentId: partial.parentId ?? null,
    scope: partial.scope ?? 'both',
    sortOrder: partial.sortOrder ?? count,
  };
  await db.categories.put(category);
  announce('categories');
  return category;
}

export async function updateCategory(id: ID, patch: Partial<Category>): Promise<void> {
  await db.categories.update(id, touch(patch));
  announce('categories');
}

/** Tombstones a category and clears it from every receipt and item using it. */
export async function deleteCategory(id: ID): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.categories, db.receipts, db.items, async () => {
    await db.categories.update(id, { deletedAt: now, updatedAt: now, dirty: 1 });
    const receipts = await db.receipts.where('categoryId').equals(id).primaryKeys();
    for (const receiptId of receipts) {
      await db.receipts.update(receiptId, { categoryId: null, updatedAt: now, dirty: 1 });
    }
    const items = await db.items.where('categoryId').equals(id).primaryKeys();
    for (const itemId of items) {
      await db.items.update(itemId, { categoryId: null, updatedAt: now, dirty: 1 });
    }
  });
  announce('categories', 'receipts', 'items');
}

// --- tags -----------------------------------------------------------------

const TAG_COLORS = [
  '#4f7cff', '#3fa34d', '#e67e22', '#c0392b', '#8e44ad',
  '#16a085', '#d35400', '#2980b9', '#e91e63', '#7f8c8d',
];

export async function createTag(name: string, color?: string): Promise<Tag> {
  const trimmed = name.trim();
  const existing = await db.tags.where('name').equalsIgnoreCase(trimmed).first();
  if (existing && existing.deletedAt === 0) return existing;

  const count = await db.tags.count();
  const tag: Tag = {
    ...newMeta(),
    id: existing?.id ?? newId(),
    name: trimmed,
    color: color ?? TAG_COLORS[count % TAG_COLORS.length]!,
  };
  // Reuse the id of a tombstoned tag with the same name so history reconnects.
  await db.tags.put({ ...tag, deletedAt: 0 });
  announce('tags');
  return tag;
}

export async function updateTag(id: ID, patch: Partial<Tag>): Promise<void> {
  await db.tags.update(id, touch(patch));
  announce('tags');
}

export async function deleteTag(id: ID): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', db.tags, db.receiptTags, async () => {
    await db.tags.update(id, { deletedAt: now, updatedAt: now, dirty: 1 });
    const links = await db.receiptTags.where('tagId').equals(id).primaryKeys();
    for (const linkId of links) {
      await db.receiptTags.update(linkId, { deletedAt: now, updatedAt: now, dirty: 1 });
    }
  });
  announce('tags', 'receiptTags');
}

/** Replaces the full tag set of a receipt. */
export async function setReceiptTags(receiptId: ID, tagIds: ID[]): Promise<void> {
  const wanted = new Set(tagIds);
  const now = Date.now();

  await db.transaction('rw', db.receiptTags, async () => {
    const links = await db.receiptTags.where('receiptId').equals(receiptId).toArray();
    const seen = new Set<ID>();

    for (const link of links) {
      seen.add(link.tagId);
      const shouldExist = wanted.has(link.tagId);
      const exists = link.deletedAt === 0;
      if (shouldExist === exists) continue;
      await db.receiptTags.update(link.id, {
        deletedAt: shouldExist ? 0 : now,
        updatedAt: now,
        dirty: 1,
      });
    }

    for (const tagId of wanted) {
      if (seen.has(tagId)) continue;
      await db.receiptTags.put({ ...newMeta(), id: newId(), receiptId, tagId });
    }
  });
  announce('receiptTags');
}

// --- maintenance ----------------------------------------------------------

/**
 * Permanently removes tombstones the server has already acknowledged.
 *
 * A tombstone is only safe to drop once `rev > 0` (the server saw the delete)
 * and it is no longer dirty, otherwise the delete would be lost.
 */
export async function purgeTombstones(olderThanMs = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  const imageIds: string[] = [];

  for (const getTable of Object.values(SYNC_TABLES)) {
    const table = getTable();
    const doomed = await table
      .filter((row) => row.deletedAt !== 0 && row.deletedAt < cutoff && row.dirty === 0 && row.rev > 0)
      .toArray();
    for (const row of doomed) {
      if ('imageId' in row) {
        for (const key of ['imageId', 'originalImageId', 'thumbId'] as const) {
          const value = row[key];
          if (value) imageIds.push(value);
        }
      }
    }
    if (doomed.length > 0) {
      await table.bulkDelete(doomed.map((row) => row.id));
      removed += doomed.length;
    }
  }

  for (const id of imageIds) releaseBlobUrl(id);
  if (removed > 0) announce('receipts', 'items', 'categories', 'tags', 'receiptTags', 'companies');
  return removed;
}

/** Wipes every table. Used by the "erase all data" action in Settings. */
export async function eraseAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.receipts,
      db.items,
      db.categories,
      db.tags,
      db.receiptTags,
      db.companies,
      db.blobs,
      db.kv,
    ],
    async () => {
      await Promise.all([
        db.receipts.clear(),
        db.items.clear(),
        db.categories.clear(),
        db.tags.clear(),
        db.receiptTags.clear(),
        db.companies.clear(),
        db.blobs.clear(),
        // Settings and the device identity survive a data wipe on purpose.
        db.kv.where('key').startsWith('sync:').delete(),
        db.kv.where('key').equals('categories:seeded').delete(),
        // Including the negative lookup cache: with no receipts left, an org
        // number that was "not found" deserves a fresh chance.
        db.kv.where('key').startsWith('companies:').delete(),
      ]);
    },
  );
  announce('receipts', 'items', 'categories', 'tags', 'receiptTags', 'companies');
}
