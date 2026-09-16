/**
 * The boot-time schema-drift guard.
 *
 * `db/index.ts` runs its DDL as idempotent `CREATE TABLE IF NOT EXISTS`, so it
 * never touches a table that already exists — which is exactly how a
 * database that predates a column `schema.ts` now declares would slip past
 * it. This drops a column directly, the same shape of gap, and checks that
 * the next `getConnection()` refuses to start instead of leaving the gap for
 * some later query to trip over.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'kvitto-schema-test-'));
process.env['KVITTO_DATA_DIR'] = dataDir;
process.env['LOG_LEVEL'] = 'silent';

test('server initialisation refuses to start when a table has drifted from its Drizzle definition', async () => {
  const Database = (await import('better-sqlite3')).default;
  const { config } = await import('../dist/env.js');
  const { getConnection, closeDatabase } = await import('../dist/db/index.js');

  // An ordinary first boot: the real DDL runs and the schema matches, so this
  // must not throw.
  getConnection();
  closeDatabase();

  // Simulate drift the way it actually happens: an existing database file
  // that predates a column the Drizzle table now declares. Dropping one
  // directly, bypassing both `getConnection()` and its added-column list, is
  // the same shape of gap a real upgrade could leave behind.
  const raw = new Database(config.databasePath);
  raw.exec('ALTER TABLE receipts DROP COLUMN last_device_id');
  raw.close();

  assert.throws(
    () => getConnection(),
    (error: unknown) =>
      error instanceof Error && /receipts/.test(error.message) && /last_device_id/.test(error.message),
    'expected initialisation to name the drifted table and column',
  );

  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});
