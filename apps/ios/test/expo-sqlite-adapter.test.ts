import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { InMemoryDatabaseKeyStore } from '../src/data/keychain';
import { IosDataRepository } from '../src/data/repository';
import { DATABASE_KEY_NAME, startDataFoundation } from '../src/data/startup';
import { ExpoSqliteAdapter } from '../src/data/expo-sqlite-adapter';

type RunCall = { sql: string; params: unknown[]; inTransaction: boolean };

const execCalls: string[] = [];
const runCalls: RunCall[] = [];
const createdTables = new Set<string>();
const kvRows = new Map<string, string>();
let openTransactionDepth = 0;
let newConnectionsOpened = 0;

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function maybeTrackCreateTable(sql: string): void {
  const match = sql.match(/create table if not exists\s+([a-zA-Z0-9_]+)/i);
  if (match?.[1]) createdTables.add(match[1]);
}

function maybeTrackCreateVirtualTable(sql: string): void {
  const match = sql.match(/create virtual table if not exists\s+([a-zA-Z0-9_]+)/i);
  if (match?.[1]) createdTables.add(match[1]);
}

const mockDb = {
  execAsync: jest.fn(async (sql: string) => {
    execCalls.push(sql);
    maybeTrackCreateTable(sql);
    maybeTrackCreateVirtualTable(sql);
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('begin')) openTransactionDepth += 1;
    if (normalized.startsWith('commit') || normalized.startsWith('rollback')) {
      openTransactionDepth = Math.max(0, openTransactionDepth - 1);
    }
  }),
  runAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
    runCalls.push({ sql, params, inTransaction: openTransactionDepth > 0 });
    if (normalizeSql(sql).startsWith('insert into kv(')) {
      const key = String(params[0] ?? '');
      const value = String(params[1] ?? '');
      kvRows.set(key, value);
    }
    if (normalizeSql(sql).startsWith('delete from kv')) {
      kvRows.clear();
    }
    return { changes: 1, lastInsertRowId: 0 };
  }),
  withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
    await task();
  }),
  // Mirrors expo-sqlite: this helper opens a SECOND native connection, which on a
  // SQLCipher database has no key. The adapter must never route statements here.
  withExclusiveTransactionAsync: jest.fn(async (task: (transaction: typeof mockDb) => Promise<void>) => {
    newConnectionsOpened += 1;
    await task(mockDb);
  }),
  getFirstAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
    const normalized = normalizeSql(sql);
    if (normalized.includes('from sqlite_master')) {
      const name = String(params[0] ?? '');
      return { count: createdTables.has(name) ? 1 : 0 };
    }
    if (normalized.startsWith('select value from kv')) {
      const key = String(params[0] ?? '');
      const value = kvRows.get(key);
      return value ? { value } : null;
    }
    return null;
  }),
  getAllAsync: jest.fn(async (sql: string) => {
    const normalized = normalizeSql(sql);
    if (normalized.startsWith('select key, value from kv')) {
      return [...kvRows.entries()].map(([key, value]) => ({ key, value }));
    }
    return [];
  }),
};

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => mockDb),
}));

describe('ExpoSqliteAdapter startup and SQL contract', () => {
  beforeEach(() => {
    execCalls.length = 0;
    runCalls.length = 0;
    createdTables.clear();
    kvRows.clear();
    openTransactionDepth = 0;
    newConnectionsOpened = 0;
    mockDb.withExclusiveTransactionAsync.mockClear();
  });

  test('applies SQLCipher key before WAL/FK and before schema migration SQL', async () => {
    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-startup-test.db' });
    const keyStore = new InMemoryDatabaseKeyStore();
    await keyStore.write(DATABASE_KEY_NAME, '00112233445566778899aabbccddeeff');
    const repository = new IosDataRepository(db, () => 1_000);

    await startDataFoundation({ db, keyStore, repository });

    const keyIndex = execCalls.findIndex((sql) => normalizeSql(sql).startsWith("pragma key = \"x'"));
    const walIndex = execCalls.findIndex((sql) => normalizeSql(sql).includes('pragma journal_mode = wal'));
    const fkIndex = execCalls.findIndex((sql) => normalizeSql(sql).includes('pragma foreign_keys = on'));
    const migrationIndex = execCalls.findIndex((sql) => normalizeSql(sql).startsWith('create table if not exists canonical_entities'));

    expect(keyIndex).toBeGreaterThanOrEqual(0);
    expect(walIndex).toBeGreaterThan(keyIndex);
    expect(fkIndex).toBeGreaterThan(walIndex);
    expect(migrationIndex).toBeGreaterThan(fkIndex);
  });

  test('persists canonical and projection rows via SQL after repository mutation', async () => {
    createdTables.add('canonical_entities');
    createdTables.add('receipt_projections');
    createdTables.add('item_projections');
    createdTables.add('receipt_fts');
    createdTables.add('item_fts');
    createdTables.add('kv');

    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-contract-test.db' });
    const repository = new IosDataRepository(db, () => 2_000);

    await repository.createReceipt({ id: 'receipt-1' });

    const canonicalInsert = runCalls.find((call) => normalizeSql(call.sql).includes('insert into canonical_entities'));
    const receiptProjectionInsert = runCalls.find((call) => normalizeSql(call.sql).includes('insert into receipt_projections'));

    expect(canonicalInsert).toBeDefined();
    expect(receiptProjectionInsert).toBeDefined();
    expect(canonicalInsert?.inTransaction).toBe(true);
    expect(receiptProjectionInsert?.inTransaction).toBe(true);

    const begin = execCalls.findIndex((sql) => normalizeSql(sql) === 'begin immediate');
    const commit = execCalls.findIndex((sql) => normalizeSql(sql) === 'commit');
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(openTransactionDepth).toBe(0);
  });

  test('never opens a second connection, which on a SQLCipher database has no key', async () => {
    createdTables.add('canonical_entities');
    createdTables.add('receipt_projections');
    createdTables.add('item_projections');
    createdTables.add('receipt_fts');
    createdTables.add('item_fts');
    createdTables.add('kv');

    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-single-connection.db' });
    const repository = new IosDataRepository(db, () => 3_000);

    await repository.createReceipt({ id: 'receipt-2' });
    await repository.setKeyValue('device:name', 'Test iPhone');
    await repository.rebuildFts();
    await repository.getSpendSummary();

    expect(newConnectionsOpened).toBe(0);
    expect(mockDb.withExclusiveTransactionAsync).not.toHaveBeenCalled();
  });

  test('a failed transaction rolls back on the same connection', async () => {
    createdTables.add('canonical_entities');
    createdTables.add('receipt_projections');
    createdTables.add('kv');

    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-rollback.db' });

    await expect(
      db.transaction(async () => {
        await db.run('INSERT INTO kv(key, value) VALUES (?, ?)', ['a', 'b']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const normalized = execCalls.map(normalizeSql);
    expect(normalized).toContain('begin immediate');
    expect(normalized).toContain('rollback');
    expect(normalized).not.toContain('commit');
    expect(newConnectionsOpened).toBe(0);
  });
  test('concurrent transactions are queued, never interleaved into a second BEGIN', async () => {
    createdTables.add('kv');
    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-concurrent.db' });

    const order: string[] = [];
    const settle = async (label: string) => {
      order.push(`${label}:start`);
      // Yield repeatedly so an unqueued implementation would interleave here.
      await Promise.resolve();
      await Promise.resolve();
      await db.run('INSERT INTO kv(key, value) VALUES (?, ?)', [label, label]);
      order.push(`${label}:end`);
    };

    await Promise.all([
      db.transaction(() => settle('a')),
      db.transaction(() => settle('b')),
      db.transaction(() => settle('c')),
    ]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);

    const normalized = execCalls.map(normalizeSql).filter((sql) => sql === 'begin immediate' || sql === 'commit');
    expect(normalized).toEqual([
      'begin immediate',
      'commit',
      'begin immediate',
      'commit',
      'begin immediate',
      'commit',
    ]);
  });

  test('a failed transaction does not poison the queue for later callers', async () => {
    createdTables.add('kv');
    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-queue-recovery.db' });

    await expect(
      db.transaction(async () => {
        throw new Error('first fails');
      }),
    ).rejects.toThrow('first fails');

    await expect(
      db.transaction(async () => {
        await db.run('INSERT INTO kv(key, value) VALUES (?, ?)', ['after', 'ok']);
        return 'second succeeds';
      }),
    ).resolves.toBe('second succeeds');
  });
});
