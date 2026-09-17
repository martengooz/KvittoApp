import type { SecureCredentialSnapshot, SecureCredentialsPort } from '../features/settings/types';

const PAIRING_TOKEN_KEY = 'settings.credentials.pairingToken';
const AI_API_KEY = 'settings.credentials.aiApiKey';
const COMPANY_API_KEY = 'settings.credentials.companyApiKey';

/** Every SecureStore key this module owns, so their names can be checked. */
export const SECURE_CREDENTIAL_KEY_NAMES = [PAIRING_TOKEN_KEY, AI_API_KEY, COMPANY_API_KEY] as const;

export interface SecureStoreWriteOptions {
  keychainAccessible?: string | number;
}

export interface SecureStoreBackend {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string, options?: SecureStoreWriteOptions): Promise<void>;
  deleteItem(name: string): Promise<void>;
  whenUnlockedThisDeviceOnly?: string | number;
}

export class SecureStoreCredentialStore {
  private readonly backend: SecureStoreBackend;

  constructor(backend: SecureStoreBackend) {
    this.backend = backend;
  }

  async readAll(): Promise<SecureCredentialSnapshot> {
    const [pairingToken, aiApiKey, companyApiKey] = await Promise.all([
      this.backend.getItem(PAIRING_TOKEN_KEY),
      this.backend.getItem(AI_API_KEY),
      this.backend.getItem(COMPANY_API_KEY),
    ]);

    return {
      pairingToken,
      aiApiKey,
      companyApiKey,
    };
  }

  async writeAll(next: SecureCredentialSnapshot): Promise<void> {
    await Promise.all([
      this.writeSecret(PAIRING_TOKEN_KEY, next.pairingToken),
      this.writeSecret(AI_API_KEY, next.aiApiKey),
      this.writeSecret(COMPANY_API_KEY, next.companyApiKey),
    ]);
  }

  async clearAll(): Promise<void> {
    await Promise.all([
      this.backend.deleteItem(PAIRING_TOKEN_KEY),
      this.backend.deleteItem(AI_API_KEY),
      this.backend.deleteItem(COMPANY_API_KEY),
    ]);
  }

  async readPairingToken(): Promise<string | null> {
    return this.backend.getItem(PAIRING_TOKEN_KEY);
  }

  async writePairingToken(token: string): Promise<void> {
    await this.writeSecret(PAIRING_TOKEN_KEY, token);
  }

  async clearPairingToken(): Promise<void> {
    await this.backend.deleteItem(PAIRING_TOKEN_KEY);
  }

  private async writeSecret(name: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.backend.deleteItem(name);
      return;
    }

    await this.backend.setItem(name, value, {
      keychainAccessible: this.backend.whenUnlockedThisDeviceOnly,
    });
  }
}

export class SecureStoreSettingsCredentialsPort implements SecureCredentialsPort {
  private readonly store: SecureStoreCredentialStore;

  constructor(store: SecureStoreCredentialStore) {
    this.store = store;
  }

  async get(): Promise<SecureCredentialSnapshot> {
    return this.store.readAll();
  }

  async set(next: SecureCredentialSnapshot): Promise<void> {
    await this.store.writeAll(next);
  }

  async clear(): Promise<void> {
    await this.store.clearAll();
  }
}

export class SecureStorePairingTokenVault {
  private readonly store: SecureStoreCredentialStore;

  constructor(store: SecureStoreCredentialStore) {
    this.store = store;
  }

  async get(): Promise<string | null> {
    return this.store.readPairingToken();
  }

  async set(token: string): Promise<void> {
    await this.store.writePairingToken(token);
  }

  async clear(): Promise<void> {
    await this.store.clearPairingToken();
  }
}

export function createSecureStoreCredentialPorts(backend: SecureStoreBackend): {
  settingsCredentials: SecureCredentialsPort;
  pairingTokenVault: SecureStorePairingTokenVault;
} {
  const store = new SecureStoreCredentialStore(backend);
  return {
    settingsCredentials: new SecureStoreSettingsCredentialsPort(store),
    pairingTokenVault: new SecureStorePairingTokenVault(store),
  };
}