import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type {
  SqlParam,
  SqliteDiagnostics,
  SqliteLikeAdapter,
} from './sqlite-like';

export class ExpoSqliteAdapterError extends Error {
  readonly step: string;

  readonly hint: string;

  constructor(step: string, hint: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`SQLite startup failed at ${step}: ${reason}. ${hint}`);
    this.name = 'ExpoSqliteAdapterError';
    this.step = step;
    this.hint = hint;
  }
}

export interface ExpoSqliteAdapterOpenInput {
  databaseName?: string;
}

/**
 * Production SQLite adapter. Every statement runs against the database directly;
 * while a repository transaction is open they are routed through that one
 * exclusive transaction handle so reads and writes see the same snapshot and
 * roll back together.
 */
export class ExpoSqliteAdapter implements SqliteLikeAdapter {
  private readonly diagnostics: SqliteDiagnostics = {
    keyed: false,
    keyId: null,
    journalMode: 'delete',
    foreignKeysEnabled: false,
    migrations: [],
  };

  private activeTransaction: SQLiteDatabase | null = null;

  private transactionDepth = 0;

  private constructor(private readonly db: SQLiteDatabase) {}

  static async openAsync(input: ExpoSqliteAdapterOpenInput = {}): Promise<ExpoSqliteAdapter> {
    const databaseName = input.databaseName ?? 'kvitto-ios.db';
    const db = await openDatabaseAsync(databaseName);
    return new ExpoSqliteAdapter(db);
  }

  getDiagnostics(): SqliteDiagnostics {
    return this.diagnostics;
  }

  private get target(): SQLiteDatabase {
    return this.activeTransaction ?? this.db;
  }

  async execute(sql: string): Promise<void> {
    await this.target.execAsync(sql);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    await this.target.runAsync(sql, ...params);
  }

  async selectFirst<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    return (await this.target.getFirstAsync<T>(sql, ...params)) ?? null;
  }

  async selectAll<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.target.getAllAsync<T>(sql, ...params);
  }

  async tableExists(name: string): Promise<boolean> {
    const row = await this.selectFirst<{ count: number }>(
      "SELECT count(*) as count FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
      [name],
    );
    return Boolean(row?.count);
  }

  async applySqlCipherKey(keyId: string): Promise<void> {
    try {
      await this.db.execAsync(`PRAGMA key = "x'${keyId}'"`);
      this.diagnostics.keyed = true;
      this.diagnostics.keyId = keyId;
    } catch (error) {
      throw new ExpoSqliteAdapterError(
        'apply-sqlcipher-key',
        'Verify the expo-sqlite config plugin enables SQLCipher and run pod install again.',
        error,
      );
    }
  }

  async enableWal(): Promise<void> {
    try {
      await this.db.execAsync('PRAGMA journal_mode = WAL');
      this.diagnostics.journalMode = 'wal';
    } catch (error) {
      throw new ExpoSqliteAdapterError(
        'enable-wal',
        'Check SQLite open mode and ensure the app can write in its documents directory.',
        error,
      );
    }
  }

  async setForeignKeys(enabled: boolean): Promise<void> {
    try {
      await this.db.execAsync(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
      this.diagnostics.foreignKeysEnabled = enabled;
    } catch (error) {
      throw new ExpoSqliteAdapterError(
        'set-foreign-keys',
        'Confirm SQLite runtime is initialized before schema migration starts.',
        error,
      );
    }
  }

  async applyMigration(id: string, statements: string[]): Promise<void> {
    if (this.diagnostics.migrations.some((row) => row.id === id)) return;
    try {
      await this.db.withTransactionAsync(async () => {
        for (const statement of statements) {
          await this.db.execAsync(statement);
        }
      });
      this.diagnostics.migrations.push({ id, statements: [...statements] });
    } catch (error) {
      throw new ExpoSqliteAdapterError(
        `apply-migration:${id}`,
        'Run migrations in order and inspect SQL syntax in drizzle/migrations.ts.',
        error,
      );
    }
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeTransaction) {
      this.transactionDepth += 1;
      try {
        return await work();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    let result: T;
    try {
      await this.db.withExclusiveTransactionAsync(async (transaction) => {
        this.activeTransaction = transaction;
        this.transactionDepth = 1;
        result = await work();
      });
      return result!;
    } finally {
      this.activeTransaction = null;
      this.transactionDepth = 0;
    }
  }
}
