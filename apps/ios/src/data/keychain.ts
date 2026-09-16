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

export function generateDatabaseKey(length = 64): string {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? '0';
  }
  return out;
}
