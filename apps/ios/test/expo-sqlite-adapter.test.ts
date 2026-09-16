import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { InMemoryDatabaseKeyStore } from '../src/data/keychain';
import { IosDataRepository } from '../src/data/repository';
import { startDataFoundation } from '../src/data/startup';
import { ExpoSqliteAdapter } from '../src/data/expo-sqlite-adapter';

type RunCall = { sql: string; params: unknown[]; inExclusiveTransaction: boolean };

const execCalls: string[] = [];
const runCalls: RunCall[] = [];
const createdTables = new Set<string>();
const kvRows = new Map<string, string>();
let exclusiveTransactionDepth = 0;

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
  }),
  runAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
    runCalls.push({ sql, params, inExclusiveTransaction: exclusiveTransactionDepth > 0 });
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
  withExclusiveTransactionAsync: jest.fn(async (task: (transaction: typeof mockDb) => Promise<void>) => {
    exclusiveTransactionDepth += 1;
    try {
      await task(mockDb);
    } finally {
      exclusiveTransactionDepth -= 1;
    }
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
    exclusiveTransactionDepth = 0;
    mockDb.withExclusiveTransactionAsync.mockClear();
  });

  test('applies SQLCipher key before WAL/FK and before schema migration SQL', async () => {
    const db = await ExpoSqliteAdapter.openAsync({ databaseName: 'packet3-startup-test.db' });
    const keyStore = new InMemoryDatabaseKeyStore();
    await keyStore.write('ios:data:sqlcipher-key', '00112233445566778899aabbccddeeff');
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
    expect(canonicalInsert?.inExclusiveTransaction).toBe(true);
    expect(receiptProjectionInsert?.inExclusiveTransaction).toBe(true);
    expect(mockDb.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
  });
});
