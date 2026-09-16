/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';

import {
  createSecureStoreCredentialPorts,
  type SecureStoreBackend,
  type SecureStoreWriteOptions,
} from '../src/data/secure-credentials';
import { SettingsFeatureController } from '../src/features/settings';
import { createCredentialsAdapter, type IdentityStateStore } from '../src/sync/identity';

type SecureWriteRecord = {
  name: string;
  value: string;
  options?: SecureStoreWriteOptions;
};

class SharedFakeSecureStoreBackend implements SecureStoreBackend {
  readonly whenUnlockedThisDeviceOnly = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

  private readonly values: Map<string, string>;
  readonly writes: SecureWriteRecord[] = [];

  constructor(values: Map<string, string>) {
    this.values = values;
  }

  async getItem(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async setItem(name: string, value: string, options?: SecureStoreWriteOptions): Promise<void> {
    this.values.set(name, value);
    this.writes.push({ name, value, options });
  }

  async deleteItem(name: string): Promise<void> {
    this.values.delete(name);
  }
}

class InMemoryIdentityStateStore implements IdentityStateStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function createSettingsController() {
  const sharedValues = new Map<string, string>();
  const backend = new SharedFakeSecureStoreBackend(sharedValues);
  const ports = createSecureStoreCredentialPorts(backend);

  return {
    backend,
    ports,
    controller: new SettingsFeatureController({
      pairing: {
        serverUrl: '',
        paired: false,
        deviceName: 'Test iPhone',
        accountHint: null,
      },
      image: {
        autoCapture: true,
        jpegQuality: 0.9,
        colorMode: 'grayscale',
      },
      ocr: {
        languages: ['sv-SE'],
        languageCorrection: true,
      },
      ai: {
        mode: 'remote',
        provider: 'openai',
        model: 'gpt-4.1-mini',
      },
      sync: {
        autoSync: true,
        wifiOnly: true,
      },
      migration: {
        lastImportAt: null,
        lastExportAt: null,
        lastPreflightSummary: null,
      },
      storage: {
        blobCount: 0,
        blobBytes: 0,
        hasPersistentStorage: false,
      },
      about: {
        appName: 'KvittoApp iOS',
        appVersion: 'test',
        nativeVersion: 'test',
      },
      secureCredentials: ports.settingsCredentials,
      diagnostics: {
        read: async () => ({ status: 'ok' }),
      },
    }),
  };
}

describe('secure credentials persistence and composition', () => {
  test('persists secrets across adapter instances with shared backend', async () => {
    const sharedValues = new Map<string, string>();
    const backendA = new SharedFakeSecureStoreBackend(sharedValues);
    const backendB = new SharedFakeSecureStoreBackend(sharedValues);

    const portsA = createSecureStoreCredentialPorts(backendA);
    const portsB = createSecureStoreCredentialPorts(backendB);

    await portsA.settingsCredentials.set({
      pairingToken: 'pair-123',
      aiApiKey: 'ai-123',
      companyApiKey: 'company-123',
    });

    await expect(portsB.settingsCredentials.get()).resolves.toEqual({
      pairingToken: 'pair-123',
      aiApiKey: 'ai-123',
      companyApiKey: 'company-123',
    });

    expect(backendA.writes).toHaveLength(3);
    for (const write of backendA.writes) {
      expect(write.options?.keychainAccessible).toBe('WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    }
  });

  test('applies partial secure-credential updates through settings controller', async () => {
    const setup = createSettingsController();

    await setup.controller.setSecureCredentials({ pairingToken: 'pair-abc' });
    await setup.controller.setSecureCredentials({ aiApiKey: 'ai-abc' });

    await expect(setup.ports.settingsCredentials.get()).resolves.toEqual({
      pairingToken: 'pair-abc',
      aiApiKey: 'ai-abc',
      companyApiKey: null,
    });

    const snapshot = await setup.controller.getSnapshot();
    expect(snapshot.credentialPresence.pairingToken).toBe(true);
    expect(snapshot.credentialPresence.aiApiKey).toBe(true);
    expect(snapshot.credentialPresence.companyApiKey).toBe(false);
  });

  test('clears/deletes secure credentials from backend', async () => {
    const setup = createSettingsController();

    await setup.ports.settingsCredentials.set({
      pairingToken: 'pair-z',
      aiApiKey: 'ai-z',
      companyApiKey: 'co-z',
    });
    await setup.controller.clearSecureCredentials();

    await expect(setup.ports.settingsCredentials.get()).resolves.toEqual({
      pairingToken: null,
      aiApiKey: null,
      companyApiKey: null,
    });
    expect(setup.backend.writes).toHaveLength(3);
  });

  test('shares pairing token between settings port and sync credentials token vault', async () => {
    const sharedValues = new Map<string, string>();
    const backend = new SharedFakeSecureStoreBackend(sharedValues);
    const ports = createSecureStoreCredentialPorts(backend);
    const state = new InMemoryIdentityStateStore();
    const credentials = createCredentialsAdapter({
      state,
      tokenVault: ports.pairingTokenVault,
    });

    await credentials.set({
      deviceId: 'device-1',
      accountId: 'account-1',
      token: 'pair-sync-1',
    });

    await expect(ports.settingsCredentials.get()).resolves.toEqual({
      pairingToken: 'pair-sync-1',
      aiApiKey: null,
      companyApiKey: null,
    });

    await ports.settingsCredentials.set({
      pairingToken: 'pair-sync-2',
      aiApiKey: null,
      companyApiKey: null,
    });

    await expect(credentials.get()).resolves.toEqual({
      deviceId: 'device-1',
      accountId: 'account-1',
      token: 'pair-sync-2',
    });
  });
});