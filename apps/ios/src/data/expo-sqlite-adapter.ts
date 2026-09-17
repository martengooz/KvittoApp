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
 * Production SQLite adapter. Every statement runs on one connection, the one
 * `PRAGMA key` was applied to.
 *
 * Transactions are explicit `BEGIN IMMEDIATE`/`COMMIT` rather than expo-sqlite's
 * `withExclusiveTransactionAsync`, because that helper opens a second native
 * connection (`useNewConnection: true`). A second connection to a SQLCipher
 * database has no key, so every statement issued through it fails.
 */
export class ExpoSqliteAdapter implements SqliteLikeAdapter {
  private readonly diagnostics: SqliteDiagnostics = {
    keyed: false,
    keyId: null,
    journalMode: 'delete',
    foreignKeysEnabled: false,
    migrations: [],
  };

  private transactionDepth = 0;

  /** Serializes top-level transactions; see `transaction`. */
  private transactionQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly db: SQLiteDatabase) {}

  static async openAsync(input: ExpoSqliteAdapterOpenInput = {}): Promise<ExpoSqliteAdapter> {
    const databaseName = input.databaseName ?? 'kvitto-ios.db';
    const db = await openDatabaseAsync(databaseName);
    return new ExpoSqliteAdapter(db);
  }

  getDiagnostics(): SqliteDiagnostics {
    return this.diagnostics;
  }

  async execute(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    await this.db.runAsync(sql, ...params);
  }

  async selectFirst<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    return (await this.db.getFirstAsync<T>(sql, ...params)) ?? null;
  }

  async selectAll<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, ...params);
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

  /**
   * Runs `work` inside one transaction on the single keyed connection.
   *
   * Top-level calls are queued rather than interleaved: `BEGIN IMMEDIATE` is
   * awaited, so without a queue two concurrent callers could both get past the
   * depth check and issue a second `BEGIN`, which SQLite rejects and whose
   * `ROLLBACK` would discard the other caller's work. A call made from inside
   * `work` joins the open transaction instead, because SQLite has no real
   * nesting and an inner failure has to abort the whole unit of work anyway.
   */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return await work();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    const run = this.transactionQueue.then(() => this.runTransaction(work));
    // Failures must not poison the queue for later callers.
    this.transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTransaction<T>(work: () => Promise<T>): Promise<T> {
    await this.db.execAsync('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = await work();
      await this.db.execAsync('COMMIT');
      return result;
    } catch (error) {
      await this.db.execAsync('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
}
