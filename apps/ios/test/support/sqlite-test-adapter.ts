import Database from 'better-sqlite3';

import { IOS_DATA_MIGRATIONS } from '../../drizzle/migrations';
import type { SqlParam, SqliteDiagnostics, SqliteLikeAdapter } from '../../src/data/sqlite-like';

/**
 * Test/host adapter over a real SQLite database. It runs the same SQL the
 * production adapter runs, so query, FTS, trigger, and rollback behaviour is
 * exercised rather than simulated. Pass a file path instead of the default
 * `:memory:` to model an app relaunch against the same database.
 */
export class SqliteTestAdapter implements SqliteLikeAdapter {
  private readonly db: Database.Database;

  private readonly diagnostics: SqliteDiagnostics = {
    keyed: false,
    keyId: null,
    journalMode: 'delete',
    foreignKeysEnabled: false,
    migrations: [],
  };

  private transactionDepth = 0;

  constructor(databasePath = ':memory:') {
    this.db = new Database(databasePath);
    for (const migration of IOS_DATA_MIGRATIONS) {
      for (const statement of migration.statements) this.db.exec(statement);
      this.diagnostics.migrations.push({ id: migration.id, statements: [...migration.statements] });
    }
  }

  getDiagnostics(): SqliteDiagnostics {
    return this.diagnostics;
  }

  async execute(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async selectFirst<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  async selectAll<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async tableExists(name: string): Promise<boolean> {
    const row = await this.selectFirst<{ count: number }>(
      "SELECT count(*) as count FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
      [name],
    );
    return Boolean(row?.count);
  }

  async applySqlCipherKey(keyId: string): Promise<void> {
    this.diagnostics.keyed = true;
    this.diagnostics.keyId = keyId;
  }

  async enableWal(): Promise<void> {
    this.diagnostics.journalMode = 'wal';
  }

  async setForeignKeys(enabled: boolean): Promise<void> {
    this.db.exec(`PRAGMA foreign_keys = ${enabled ? 'ON' : 'OFF'}`);
    this.diagnostics.foreignKeysEnabled = enabled;
  }

  async applyMigration(id: string, statements: string[]): Promise<void> {
    if (this.diagnostics.migrations.some((row) => row.id === id)) return;
    this.db.exec('BEGIN');
    try {
      for (const statement of statements) this.db.exec(statement);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.diagnostics.migrations.push({ id, statements: [...statements] });
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return await work();
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try {
      const result = await work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}
