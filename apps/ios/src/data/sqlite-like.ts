
export type SqlParam = string | number | null;

export interface AppliedMigration {
  id: string;
  statements: string[];
}

export interface SqliteDiagnostics {
  keyed: boolean;
  keyId: string | null;
  journalMode: 'delete' | 'wal';
  foreignKeysEnabled: boolean;
  migrations: AppliedMigration[];
}

/** The SQL surface the repository is written against. */
export interface SqlExecutor {
  execute(sql: string): Promise<void>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  selectFirst<T>(sql: string, params?: SqlParam[]): Promise<T | null>;
  selectAll<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
}

export interface SqliteLikeAdapter extends SqlExecutor {
  getDiagnostics(): SqliteDiagnostics;
  applySqlCipherKey(keyId: string): Promise<void>;
  enableWal(): Promise<void>;
  setForeignKeys(enabled: boolean): Promise<void>;
  applyMigration(id: string, statements: string[]): Promise<void>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  tableExists(name: string): Promise<boolean>;
}
