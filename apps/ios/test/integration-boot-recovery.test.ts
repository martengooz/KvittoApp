import { describe, expect, test } from '@jest/globals';

import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { createFakeScanCameraBridge, createNativeFacadeStub } from './support/scan-fakes';
import type { ScanFeatureController, ScanState } from '../src/features/scan';
import { SettingsFeatureController } from '../src/features/settings';
import {
  composeTabFeatureServices,
  runBootAttempt,
  type AppBootstrap,
  type AppServiceComposition,
} from '../src/app/services';
import { DEFAULT_COMPANY_SETTINGS } from '../src/features/settings/types';

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
    refreshPermission: () => 'unavailable' as const,
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
    company: DEFAULT_COMPANY_SETTINGS,
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

function makeComposition(): AppServiceComposition {
  const repository = new IosDataRepository(new SqliteTestAdapter(), () => 1000);
  const scanController = makeFakeScanController();
  const settingsController = makeFakeSettingsController();
  let active = true;

  return {
    startup: {
      keyId: 'test-key',
      migrationIds: ['0001_init'],
      steps: ['keychain-key-ready', 'migrations-applied'],
    },
    repository,
    sync: {
      getSnapshot: () => ({
        config: { serverUrl: '', autoSync: true, wifiOnly: true },
        paired: false,
        accountHint: null,
        deviceName: 'Test device',
        engine: {
          status: 'idle',
          inFlight: false,
          lastSuccessAt: null,
          lastError: null,
          pendingDirty: 0,
          cursor: { cursor: 0, epoch: 'epoch-1' },
        },
      }),
      subscribe: () => () => undefined,
      runManual: async () => ({
        pushed: 0,
        pulled: 0,
        uploadedBlobs: 0,
        downloadedBlobs: 0,
        deferredBlobDownloads: 0,
        cursor: { cursor: 0, epoch: 'epoch-1' },
        pullProgress: { pages: 0, records: 0 },
        resetCursor: false,
      }),
      pair: async () => ({
        token: 'token',
        accountId: 'acc-1',
        deviceId: 'dev-1',
        deviceName: 'Test device',
        protocolVersion: 2,
        serverTime: Date.now(),
      }),
      unpair: async () => undefined,
      updateConfig: async () => undefined,
      dispose: () => undefined,
    },
    company: {
      resolve: async () => ({ status: 'skipped' as const, reason: 'not-configured' as const }),
      resolveByName: async () => ({ status: 'skipped' as const, reason: 'not-configured' as const }),
      searchBudgetUsed: async () => 0,
      clearMisses: async () => undefined,
    },
    background: {
      start: async () => 'unavailable' as const,
      stop: () => undefined,
      schedule: async () => 'unavailable' as const,
      runLaunch: async () => null,
      sweepNow: async () => null,
      isRunning: () => false,
    },
    jobs: {
      enqueue: async () => {
        throw new Error('not-implemented');
      },
      list: async () => [],
      cancel: async () => undefined,
      sweepBackground: async () => ({
        outcome: 'unsupported' as const,
        summary: null,
        pendingJobs: 0,
      }),
      drainForeground: async () => ({
        outcome: 'unsupported',
        summary: null,
        pendingJobs: 0,
      }),
      stop: () => {
        active = false;
      },
      start: () => {
        active = true;
      },
      isActive: () => active,
    },
    tabs: composeTabFeatureServices({
      repository,
      scanController,
      scanCamera: createFakeScanCameraBridge(),
      native: createNativeFacadeStub(),
      settingsController,
    }),
    dispose() {
      active = false;
    },
  };
}

describe('integration boot recovery', () => {
  test('returns diagnostics on failure and recovers on retry bootstrap', async () => {
    let attempts = 0;
    const bootstrap: AppBootstrap = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Keychain unavailable');
      }
      return makeComposition();
    };

    const first = await runBootAttempt(bootstrap);
    expect(first.boot.status).toBe('error');
    expect(first.boot.diagnostics?.details).toContain('Keychain unavailable');
    expect(first.composition).toBeNull();

    const second = await runBootAttempt(bootstrap);
    expect(second.boot.status).toBe('ready');
    expect(second.composition).not.toBeNull();
    expect(second.composition?.tabs.receipts.repository).toBe(second.composition?.repository);

    second.composition?.dispose();
    expect(second.composition?.jobs.isActive()).toBe(false);
  });
});
