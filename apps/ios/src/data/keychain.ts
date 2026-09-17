import * as SecureStore from 'expo-secure-store';

export interface DatabaseKeyStore {
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
}

export class SecureStoreDatabaseKeyStore implements DatabaseKeyStore {
  async read(name: string): Promise<string | null> {
    return SecureStore.getItemAsync(name);
  }

  async write(name: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(name, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
}

export class InMemoryDatabaseKeyStore implements DatabaseKeyStore {
  private readonly values = new Map<string, string>();

  async read(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async write(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }
}

/**
 * Generates the SQLCipher database key as hex, from the platform CSPRNG.
 *
 * `Math.random()` is not a CSPRNG: a key drawn from it is predictable, which
 * would make encrypting the database at rest close to pointless.
 */
export function generateDatabaseKey(length = 64): string {
  if (length <= 0 || length % 2 !== 0) {
    throw new Error(`A hex database key needs an even, positive length, not ${length}.`);
  }

  const random = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(array: T) => T } }).crypto
    ?.getRandomValues;
  if (!random) {
    throw new Error('A cryptographic random source is required to create the database key.');
  }

  const bytes = random.call((globalThis as { crypto: object }).crypto, new Uint8Array(length / 2));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
