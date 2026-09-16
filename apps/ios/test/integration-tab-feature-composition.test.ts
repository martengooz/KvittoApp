import { describe, expect, test } from '@jest/globals';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import type { ScanFeatureController, ScanState } from '../src/features/scan';
import { SettingsFeatureController } from '../src/features/settings';
import {
  TAB_FEATURE_SERVICE_KEYS,
  composeTabFeatureServices,
  type TabFeatureServiceKey,
} from '../src/app/services';
import { TAB_SPECS } from '../src/app/tabs';

function makeScanState(): ScanState {
  return {
    permission: 'unknown',
    stage: 'capture',
    auto: 'off',
    manualShutterEnabled: true,
    interruption: 'none',
    frameCadenceMs: 180,
    lastFrameAnalyzedAtMs: 0,
    activeStageId: null,
    review: null,
    processing: false,
    importProgress: null,
    stalledSinceMs: null,
    recoverableStageIds: [],
  };
}

function makeFakeScanController(): ScanFeatureController {
  const state = makeScanState();
  return {
    getState: () => state,
    syncRecoverableStages: async () => undefined,
    requestPermission: async () => 'unavailable',
    startCapture: async () => undefined,
    stopCapture: async () => undefined,
    onInterruption: async () => undefined,
    ingestFrame: async () => undefined,
    manualShutter: async () => undefined,
    setCrop: async () => undefined,
    rotateClockwise: async () => undefined,
    confirm: async () => 'fake-receipt-id',
    cancelActiveOperations: async () => undefined,
    importFromLibrary: async () => ({
      total: 0,
      imported: 0,
      failed: 0,
      fallbackCount: 0,
      failures: [],
    }),
  };
}

function makeFakeSettingsController(): SettingsFeatureController {
  return new SettingsFeatureController({
    pairing: {
      serverUrl: '',
      paired: false,
      deviceName: 'Test device',
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
      mode: 'none',
      provider: 'none',
      model: 'none',
    },
    sync: {
      autoSync: false,
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
    secureCredentials: {
      get: async () => ({ pairingToken: null, aiApiKey: null, companyApiKey: null }),
      set: async () => undefined,
      clear: async () => undefined,
    },
    diagnostics: {
      read: async () => ({ source: 'test' }),
    },
  });
}

describe('integration tab feature composition', () => {
  test('maps all tab routes to typed feature services with shared repository boundary', () => {
    const repository = new IosDataRepository(new SqliteTestAdapter(), () => 1000);
    const services = composeTabFeatureServices({
      repository,
      scanController: makeFakeScanController(),
      settingsController: makeFakeSettingsController(),
    });

    const routeToService: Record<(typeof TAB_SPECS)[number]['routeName'], TabFeatureServiceKey> = {
      index: 'receipts',
      purchases: 'purchases',
      scan: 'scan',
      collections: 'collections',
      settings: 'settings',
    };

    for (const tab of TAB_SPECS) {
      const key = routeToService[tab.routeName];
      expect(TAB_FEATURE_SERVICE_KEYS).toContain(key);
      expect(services[key]).toBeDefined();
    }

    expect(services.receipts.repository).toBe(repository);
    expect(services.purchases.repository).toBe(repository);
    expect(services.collections.repository).toBe(repository);
    expect(services.scan.controller).toBeDefined();
    expect(services.settings.controller).toBeDefined();
  });
});
