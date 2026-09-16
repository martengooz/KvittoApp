import {
  TABLE_CANONICAL_ENTITIES,
  TABLE_ITEM_FTS,
  TABLE_ITEM_PROJECTIONS,
  TABLE_KV,
  TABLE_DURABLE_JOBS,
  TABLE_RECEIPT_FTS,
  TABLE_RECEIPT_PROJECTIONS,
  TABLE_SYNC_STATE,
} from './schema';

export interface MigrationDefinition {
  id: string;
  statements: string[];
}

export const IOS_DATA_MIGRATIONS: MigrationDefinition[] = [
  {
    id: '0001_initial_foundation',
    statements: [
      `CREATE TABLE IF NOT EXISTS ${TABLE_CANONICAL_ENTITIES} (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        deletedAt INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        dirty INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_canonical_dirty ON ${TABLE_CANONICAL_ENTITIES}(dirty, updatedAt)`,
      `CREATE INDEX IF NOT EXISTS idx_canonical_rev ON ${TABLE_CANONICAL_ENTITIES}(rev, updatedAt)`,
      `CREATE TABLE IF NOT EXISTS ${TABLE_RECEIPT_PROJECTIONS} (
        id TEXT PRIMARY KEY,
        updatedAt INTEGER NOT NULL,
        deletedAt INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        dirty INTEGER NOT NULL,
        purchasedAt TEXT,
        total REAL,
        merchantName TEXT,
        categoryId TEXT,
        status TEXT NOT NULL,
        itemCount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'SEK',
        searchText TEXT NOT NULL DEFAULT '',
        needsReview INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS ${TABLE_ITEM_PROJECTIONS} (
        id TEXT PRIMARY KEY,
        receiptId TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        deletedAt INTEGER NOT NULL,
        rev INTEGER NOT NULL,
        dirty INTEGER NOT NULL,
        lineNo INTEGER NOT NULL,
        searchName TEXT NOT NULL,
        categoryId TEXT,
        totalPrice REAL NOT NULL,
        unitPrice REAL,
        isDiscount INTEGER NOT NULL DEFAULT 0,
        isDeposit INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE_RECEIPT_FTS} USING fts5(id UNINDEXED, content)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE_ITEM_FTS} USING fts5(id UNINDEXED, content)`,
      `CREATE TABLE IF NOT EXISTS ${TABLE_KV} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${TABLE_SYNC_STATE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor INTEGER NOT NULL,
        epoch TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${TABLE_DURABLE_JOBS} (
        id TEXT PRIMARY KEY,
        queueName TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        runAfter INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        maxAttempts INTEGER NOT NULL,
        lastError TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_ready ON ${TABLE_DURABLE_JOBS}(status, runAfter)`,
      `CREATE TRIGGER IF NOT EXISTS trg_receipt_fts_insert
       AFTER INSERT ON ${TABLE_RECEIPT_PROJECTIONS}
       BEGIN
         INSERT INTO ${TABLE_RECEIPT_FTS}(id, content)
         VALUES (NEW.id, NEW.searchText);
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_receipt_fts_update
       AFTER UPDATE ON ${TABLE_RECEIPT_PROJECTIONS}
       BEGIN
         DELETE FROM ${TABLE_RECEIPT_FTS} WHERE id = NEW.id;
         INSERT INTO ${TABLE_RECEIPT_FTS}(id, content)
         VALUES (NEW.id, NEW.searchText);
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_receipt_fts_delete
       AFTER DELETE ON ${TABLE_RECEIPT_PROJECTIONS}
       BEGIN
         DELETE FROM ${TABLE_RECEIPT_FTS} WHERE id = OLD.id;
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_item_fts_insert
       AFTER INSERT ON ${TABLE_ITEM_PROJECTIONS}
       BEGIN
         INSERT INTO ${TABLE_ITEM_FTS}(id, content)
         VALUES (NEW.id, NEW.searchName);
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_item_fts_update
       AFTER UPDATE ON ${TABLE_ITEM_PROJECTIONS}
       BEGIN
         DELETE FROM ${TABLE_ITEM_FTS} WHERE id = NEW.id;
         INSERT INTO ${TABLE_ITEM_FTS}(id, content)
         VALUES (NEW.id, NEW.searchName);
       END`,
      `CREATE TRIGGER IF NOT EXISTS trg_item_fts_delete
       AFTER DELETE ON ${TABLE_ITEM_PROJECTIONS}
       BEGIN
         DELETE FROM ${TABLE_ITEM_FTS} WHERE id = OLD.id;
       END`,
    ],
  },
  {
    id: '0002_indexes_and_keyset',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_receipt_projection_keyset ON ${TABLE_RECEIPT_PROJECTIONS}(deletedAt, purchasedAt DESC, id ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_item_projection_keyset ON ${TABLE_ITEM_PROJECTIONS}(deletedAt, updatedAt DESC, id ASC)`,
      `CREATE INDEX IF NOT EXISTS idx_item_projection_receipt ON ${TABLE_ITEM_PROJECTIONS}(receiptId, deletedAt, lineNo)`,
    ],
  },
];
