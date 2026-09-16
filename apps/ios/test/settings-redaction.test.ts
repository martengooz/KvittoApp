import { describe, expect, test } from '@jest/globals';

import { SettingsFeatureController } from '../src/features/settings/controller';
import { redactDiagnostics } from '../src/features/settings/redaction';
import type { SecureCredentialSnapshot, SecureCredentialsPort } from '../src/features/settings/types';

class InMemorySecureCredentials implements SecureCredentialsPort {
  private state: SecureCredentialSnapshot = {
    pairingToken: null,
    aiApiKey: null,
    companyApiKey: null,
  };

  async get(): Promise<SecureCredentialSnapshot> {
    return { ...this.state };
  }

  async set(next: SecureCredentialSnapshot): Promise<void> {
    this.state = { ...next };
  }

  async clear(): Promise<void> {
    this.state = {
      pairingToken: null,
      aiApiKey: null,
      companyApiKey: null,
    };
  }
}

describe('settings redaction and secure credentials', () => {
  test('redacts sensitive debug fields recursively', () => {
    const redacted = redactDiagnostics({
      url: 'https://kvitto.app',
      authorization: 'Bearer abc',
      nested: {
        apiKey: 'secret',
        ok: true,
      },
      list: [{ token: 'abc' }, { value: 1 }],
    });

    expect(redacted.authorization).toBe('[REDACTED]');
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect(((redacted.list as unknown[])[0] as Record<string, unknown>).token).toBe('[REDACTED]');
  });

  test('reports credential presence but keeps raw credentials behind secure port', async () => {
    const secure = new InMemorySecureCredentials();
    await secure.set({
      pairingToken: 'pair-123',
      aiApiKey: 'ai-secret',
      companyApiKey: 'co-secret',
    });

    const controller = new SettingsFeatureController({
      pairing: { serverUrl: 'https://sync.example', paired: true, deviceName: 'iPhone', accountHint: 'acc-1' },
      image: { autoCapture: true, jpegQuality: 0.9, colorMode: 'grayscale' },
      ocr: { languages: ['sv-SE'], languageCorrection: true },
      ai: { mode: 'remote', provider: 'anthropic', model: 'claude-opus-5' },
      sync: { autoSync: true, wifiOnly: true },
      migration: { lastImportAt: null, lastExportAt: null, lastPreflightSummary: null },
      storage: { blobCount: 4, blobBytes: 1024, hasPersistentStorage: true },
      about: { appName: 'Kvitto', appVersion: '1.0.0', nativeVersion: '57' },
      secureCredentials: secure,
      diagnostics: {
        read: async () => ({ token: 'debug-token', status: 'ok' }),
      },
    });

    const snapshot = await controller.getSnapshot();
    expect(snapshot.credentialPresence.pairingToken).toBe(true);
    expect(snapshot.credentialPresence.aiApiKey).toBe(true);
    expect(snapshot.credentialPresence.companyApiKey).toBe(true);
    expect(snapshot.debug.redactedDiagnostics.token).toBe('[REDACTED]');
    expect(Object.keys(snapshot)).not.toContain('pairingToken');
    expect(Object.keys(snapshot)).not.toContain('aiApiKey');
  });
});
