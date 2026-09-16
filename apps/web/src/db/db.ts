/**
 * The on-device database.
 *
 * Everything the app knows lives here; the server is a replica, not the source
 * of truth. Schema notes:
 *
 * - Entity tables mirror the shared types exactly, so records can be pushed to
 *   the server without translation.
 * - `dirty` is indexed (as 0/1, since IndexedDB cannot index booleans) so the
 *   sync engine can find pending changes with a single range query.
 * - Deletes are tombstones (`deletedAt`, 0 while live), never row removals, so
 *   a delete made offline still propagates. `purgeTombstones` reaps them once
 *   the server has acknowledged them.
 * - Images live in `blobs`, keyed by SHA-256, so the same photo is stored once
 *   no matter how many receipts point at it.
 */

import Dexie, { type EntityTable } from 'dexie';
import type { Category, Company, Receipt, ReceiptItem, ReceiptTag, SyncedSecret, Tag } from '@kvitto/shared';

/** A stored image, addressed by the SHA-256 of its bytes. */
export interface StoredBlob {
  /** Lowercase hex SHA-256 of `data`. */
  id: string;
  data: Blob;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  createdAt: number;
  /** 1 once the server confirms it holds this blob. */
  uploaded: 0 | 1;
  /** What the blob is for, so cleanup can prefer dropping originals. */
  role: 'processed' | 'original' | 'thumb';
}

/** Small key/value store for settings, sync cursors and device identity. */
export interface KeyValue {
  key: string;
  value: unknown;
}

export class KvittoDatabase extends Dexie {
  receipts!: EntityTable<Receipt, 'id'>;
  items!: EntityTable<ReceiptItem, 'id'>;
  categories!: EntityTable<Category, 'id'>;
  tags!: EntityTable<Tag, 'id'>;
  receiptTags!: EntityTable<ReceiptTag, 'id'>;
  companies!: EntityTable<Company, 'id'>;
  secrets!: EntityTable<SyncedSecret, 'id'>;
  blobs!: EntityTable<StoredBlob, 'id'>;
  kv!: EntityTable<KeyValue, 'key'>;

  constructor() {
    super('kvittoapp');

    this.version(1).stores({
      // `[deletedAt+purchasedAt]` is the list view's primary path: `deletedAt`
      // is 0 for live rows, so `equals(0)`-prefixed ranges come back already
      // sorted by date. Undated receipts are handled by the query layer.
      receipts:
        'id, purchasedAt, updatedAt, dirty, status, categoryId, deletedAt, ' +
        '[deletedAt+purchasedAt], [deletedAt+updatedAt], merchant.name',
      // `searchName` powers the global purchases search.
      items:
        'id, receiptId, searchName, categoryId, totalPrice, updatedAt, dirty, deletedAt, ' +
        '[receiptId+deletedAt], [deletedAt+searchName]',
      categories: 'id, name, parentId, scope, sortOrder, updatedAt, dirty, deletedAt',
      tags: 'id, name, updatedAt, dirty, deletedAt',
      receiptTags: 'id, receiptId, tagId, updatedAt, dirty, deletedAt, [receiptId+tagId]',
      // Keyed by the unformatted organisation number, so a lookup for a
      // company already known is a primary-key hit rather than an API call.
      companies: 'id, orgNumber, name, updatedAt, dirty, deletedAt',
      blobs: 'id, createdAt, uploaded, role',
      kv: 'key',
      pendingExtractions: 'id, receiptId, createdAt, lastAttemptAt',
    });

    this.version(2).stores({
      secrets: 'id, updatedAt, dirty, deletedAt',
    });

    // `pendingExtractions` was a retry queue that never shipped — nothing ever
    // wrote to it. Mapping it to null is how Dexie drops a store, so devices
    // that have carried the empty table since version 1 let go of it too.
    this.version(3).stores({
      pendingExtractions: null,
    });
  }
}

export const db = new KvittoDatabase();

/** Entity tables that participate in sync, in dependency order. */
export const SYNC_TABLES = {
  categories: () => db.categories,
  tags: () => db.tags,
  // Before receipts: a receipt may reference a company.
  companies: () => db.companies,
  receipts: () => db.receipts,
  items: () => db.items,
  receiptTags: () => db.receiptTags,
  secrets: () => db.secrets,
} as const;

/** Reads a value from the kv store, falling back to `fallback`. */
export async function getKv<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}
