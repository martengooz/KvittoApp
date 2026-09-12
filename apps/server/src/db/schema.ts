/**
 * Server-side schema.
 *
 * The entity tables mirror the client's, with two additions:
 *
 * - `rev` is a per-account monotonic counter, assigned on every write. Clients
 *   pull `rev > cursor`, so a single integer is the whole sync cursor.
 * - Rows are scoped by `accountId`. The single-user deployment has exactly one
 *   account, but scoping from the start means multi-user is a policy change
 *   rather than a migration.
 *
 * Receipt fields that are objects on the client (`merchant`, `vatLines`) are
 * stored as JSON text. They are never queried by their contents server-side —
 * the server is a sync relay, not a query engine — so decomposing them into
 * columns would buy nothing and cost fidelity.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  /** Monotonic revision counter for this account. */
  revCounter: integer('rev_counter').notNull().default(0),
});

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull().references(() => accounts.id),
    name: text('name').notNull(),
    /** SHA-256 of the bearer token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    revokedAt: integer('revoked_at'),
  },
  (table) => [uniqueIndex('devices_token_hash_idx').on(table.tokenHash)],
);

export const pairingCodes = sqliteTable('pairing_codes', {
  code: text('code').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  usedByDeviceId: text('used_by_device_id'),
});

/** Columns every synced entity table shares. */
const syncColumns = {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  rev: integer('rev').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at').notNull().default(0),
  /** The full record as the client sent it, minus its local-only `dirty` flag. */
  payload: text('payload').notNull(),
  /** Which device last wrote this row, for debugging a sync loop. */
  lastDeviceId: text('last_device_id'),
};

export const receipts = sqliteTable(
  'receipts',
  syncColumns,
  (table) => [index('receipts_account_rev_idx').on(table.accountId, table.rev)],
);

export const items = sqliteTable(
  'items',
  syncColumns,
  (table) => [index('items_account_rev_idx').on(table.accountId, table.rev)],
);

export const categories = sqliteTable(
  'categories',
  syncColumns,
  (table) => [index('categories_account_rev_idx').on(table.accountId, table.rev)],
);

export const tags = sqliteTable(
  'tags',
  syncColumns,
  (table) => [index('tags_account_rev_idx').on(table.accountId, table.rev)],
);

export const receiptTags = sqliteTable(
  'receipt_tags',
  syncColumns,
  (table) => [index('receipt_tags_account_rev_idx').on(table.accountId, table.rev)],
);

export const blobs = sqliteTable('blobs', {
  /** SHA-256 hex of the contents; also the filename on disk. */
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  byteSize: integer('byte_size').notNull(),
  mimeType: text('mime_type').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Entity tables, keyed by the wire protocol's entity kind. */
export const ENTITY_TABLES = {
  receipts,
  items,
  categories,
  tags,
  receiptTags,
} as const;

export type EntityTableName = keyof typeof ENTITY_TABLES;
