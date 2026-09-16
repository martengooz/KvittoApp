import { IOS_DATA_MIGRATIONS } from '../../drizzle/migrations';
import { TABLE_KV } from '../../drizzle/schema';
import type { SqliteLikeAdapter } from './sqlite-like';

const APPLIED_MIGRATIONS_META_KEY = 'meta:migrations';

function parseApplied(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw) as string[];
    return new Set(list);
  } catch {
    return new Set();
  }
}

/** Reads the applied-migration ledger, tolerating a database with no schema yet. */
async function readApplied(db: SqliteLikeAdapter): Promise<Set<string>> {
  if (!(await db.tableExists(TABLE_KV))) return new Set();
  const row = await db.selectFirst<{ value: string }>(
    `SELECT value FROM ${TABLE_KV} WHERE key = ?`,
    [APPLIED_MIGRATIONS_META_KEY],
  );
  return parseApplied(row?.value ?? null);
}

export async function applyDataMigrations(db: SqliteLikeAdapter): Promise<string[]> {
  const applied = await readApplied(db);
  const newlyApplied: string[] = [];

  for (const migration of IOS_DATA_MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.applyMigration(migration.id, migration.statements);
    applied.add(migration.id);
    newlyApplied.push(migration.id);
  }

  if (newlyApplied.length > 0) {
    await db.run(
      `INSERT INTO ${TABLE_KV}(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [APPLIED_MIGRATIONS_META_KEY, JSON.stringify([...applied])],
    );
  }

  return newlyApplied;
}
