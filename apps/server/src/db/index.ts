/**
 * Database connection and schema creation.
 *
 * DDL runs at boot as idempotent `CREATE TABLE IF NOT EXISTS`, rather than
 * through a migration tool. For a self-hosted single-file SQLite deployment
 * that is strictly better: there is no separate step for the operator to forget
 * on upgrade, and no migration state to get out of step with the binary.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { config } from '../env.ts';
import * as schema from './schema.ts';

const DDL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rev_counter INTEGER NOT NULL DEFAULT 0,
  epoch TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_token_hash_idx ON devices(token_hash);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_device_id TEXT
);

CREATE TABLE IF NOT EXISTS extraction_jobs (
  receipt_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  source_updated_at INTEGER NOT NULL DEFAULT 0,
  image_id TEXT,
  last_error TEXT,
  duration_ms INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS extraction_jobs_queue_idx
  ON extraction_jobs(account_id, state, next_attempt_at);

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** The entity tables all share a shape, so their DDL is generated. */
const ENTITY_TABLE_NAMES = [
  'companies',
  'receipts',
  'items',
  'categories',
  'tags',
  'receipt_tags',
] as const;

function entityDdl(table: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  last_device_id TEXT
);
CREATE INDEX IF NOT EXISTS ${table}_account_rev_idx ON ${table}(account_id, rev);
`;
}

/**
 * Columns added after the first release.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, and
 * this server has no migration framework on purpose — it is a single-file
 * SQLite database a household runs at home, and a migration tool would be more
 * machinery than the thing it maintains. Adding a nullable column is the one
 * schema change that is safe to apply idempotently at boot, so that is the only
 * kind made here.
 */
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['accounts', 'epoch', 'TEXT'],
];

function addColumn(database: Database.Database, table: string, column: string, type: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((existing) => existing.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

let connection: Database.Database | null = null;

export function getConnection(): Database.Database {
  if (connection) return connection;

  mkdirSync(dirname(config.databasePath), { recursive: true });
  mkdirSync(config.blobDir, { recursive: true });

  const database = new Database(config.databasePath);
  // WAL lets a reader run while a sync push is committing, which matters as
  // soon as two devices sync at the same time.
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  // Durability over raw speed: this is the only copy of a user's archive that
  // is not on a phone.
  database.pragma('synchronous = FULL');
  database.pragma('busy_timeout = 5000');

  database.exec(DDL);
  for (const table of ENTITY_TABLE_NAMES) database.exec(entityDdl(table));
  for (const [table, column, type] of ADDED_COLUMNS) addColumn(database, table, column, type);

  connection = database;
  return database;
}

export function getDb() {
  return drizzle(getConnection(), { schema });
}

export function closeDatabase(): void {
  connection?.close();
  connection = null;
}

export { schema };
