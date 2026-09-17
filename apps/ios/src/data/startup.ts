import { applyDataMigrations } from './migrations';
import { generateDatabaseKey, type DatabaseKeyStore } from './keychain';
import { SecureStoreDatabaseKeyStore } from './keychain';
import { ExpoSqliteAdapter } from './expo-sqlite-adapter';
import { IosDataRepository } from './repository';
import type { SqliteLikeAdapter } from './sqlite-like';

export interface StartupHooks {
  restoreInterruptedJobs(): Promise<void>;
}

export interface DataStartupResult {
  keyId: string;
  migrationIds: string[];
  steps: string[];
}

export interface ProductionDataFoundationResult {
  db: ExpoSqliteAdapter;
  keyStore: DatabaseKeyStore;
  repository: IosDataRepository;
  startup: DataStartupResult;
}

export interface DataStartupInput {
  db: SqliteLikeAdapter;
  keyStore: DatabaseKeyStore;
  repository: IosDataRepository;
  keyName?: string;
  hooks?: Partial<StartupHooks>;
}

/**
 * SecureStore rejects any key that is not alphanumeric plus `.`, `-`, `_`, so
 * this name uses dots rather than colons. A colon here fails at startup, before
 * the database can be opened.
 */
export const DATABASE_KEY_NAME = 'ios.data.sqlcipher-key';

/** The characters SecureStore accepts in a key name. */
export const SECURE_STORE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

const DEFAULT_KEY_NAME = DATABASE_KEY_NAME;

export class DataStartupError extends Error {
  readonly code: string;

  readonly hint: string;

  constructor(code: string, message: string, hint: string, cause?: unknown) {
    const reason = cause instanceof Error ? cause.message : cause ? String(cause) : null;
    super(reason ? `${message} Cause: ${reason}. Hint: ${hint}` : `${message} Hint: ${hint}`);
    this.name = 'DataStartupError';
    this.code = code;
    this.hint = hint;
  }
}

export async function startProductionDataFoundation(
  keyName = DEFAULT_KEY_NAME,
): Promise<ProductionDataFoundationResult> {
  const keyStore = new SecureStoreDatabaseKeyStore();
  let db: ExpoSqliteAdapter;

  try {
    db = await ExpoSqliteAdapter.openAsync();
  } catch (error) {
    throw new DataStartupError(
      'db-open-failed',
      'Could not open local SQLite database.',
      'Verify expo-sqlite is installed and native pods are synced via pod install.',
      error,
    );
  }

  const repository = new IosDataRepository(db, () => Date.now());

  try {
    const startup = await startDataFoundation({
      db,
      keyStore,
      repository,
      keyName,
    });
    return {
      db,
      keyStore,
      repository,
      startup,
    };
  } catch (error) {
    throw new DataStartupError(
      'foundation-startup-failed',
      'Could not initialize encrypted data foundation.',
      'Check keychain access and SQLCipher runtime configuration in app.config.ts and iOS pods.',
      error,
    );
  }
}

export async function startDataFoundation(input: DataStartupInput): Promise<DataStartupResult> {
  const steps: string[] = [];
  const keyName = input.keyName ?? DEFAULT_KEY_NAME;

  let keyId = await input.keyStore.read(keyName);
  if (!keyId) {
    keyId = generateDatabaseKey();
    await input.keyStore.write(keyName, keyId);
  }
  steps.push('keychain-key-ready');

  await input.db.applySqlCipherKey(keyId);
  steps.push('sqlcipher-key-applied');

  await input.db.enableWal();
  steps.push('wal-enabled');

  await input.db.setForeignKeys(true);
  steps.push('foreign-keys-enabled');

  const migrationIds = await applyDataMigrations(input.db);
  steps.push('migrations-applied');

  await input.repository.rebuildFts();
  steps.push('fts-ready');

  await input.repository.seedDefaultCategoriesOnce();
  steps.push('default-categories-seeded');

  await (input.hooks?.restoreInterruptedJobs?.() ?? Promise.resolve());
  steps.push('durable-jobs-restored');

  return {
    keyId,
    migrationIds,
    steps,
  };
}
