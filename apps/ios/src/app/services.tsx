import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

import { createKvittoNativeFacade, type FrameAnalysisResult, type KvittoNativeFacade } from '../../modules/kvitto-native/src';
import {
  createSecureStoreCredentialPorts,
  IosNativeBlobStore,
  IosDataRepository,
  startProductionDataFoundation,
  type SecureStoreBackend,
  type DataStartupResult,
} from '../data';
import { createScanFeatureController, type ScanFeatureController } from '../features/scan';
import type {
  ScanCameraPort,
  ScanHapticsPort,
  ScanJobQueuePort,
  ScanLibraryPort,
  ScanStagedDescriptor,
  ScanStagingPort,
} from '../features/scan/types';
import { SettingsFeatureController, type SecureCredentialsPort } from '../features/settings';
import { createSyncConfigStore } from '../sync/config';
import { createIosSyncEngine } from '../sync/engine';
import { createCredentialsAdapter, createIdentityStateStoreFromKeyValue, type IdentityStateStore } from '../sync/identity';
import { createAppSyncService, type AppSyncService } from '../sync/service';
import { ProtocolV2Transport, type BlobFilePort } from '../sync/transport/client';
import {
  createRepositoryBackedJobStore,
  createScanDurableJobService,
  createScanDurableRunOne,
  type ForegroundDrainOutcome,
} from '../jobs';
import type { JobRecord, JobState } from '@kvitto/client-core/ports';
import { bootFailed, bootReady, initialBootState, type BootState } from './boot-state';

export interface TabFeatureServices {
  receipts: { repository: IosDataRepository };
  purchases: { repository: IosDataRepository };
  scan: { controller: ScanFeatureController };
  collections: { repository: IosDataRepository };
  settings: { controller: SettingsFeatureController };
}

export type TabFeatureServiceKey = keyof TabFeatureServices;

export interface AppServiceComposition {
  startup: DataStartupResult;
  repository: IosDataRepository;
  sync: AppSyncService;
  jobs: {
    enqueue(job: { kind: 'image-processing' | 'ocr'; receiptId: string; sourceVersion: number; sourceImageId: string | null }): Promise<JobRecord>;
    list(state?: JobState): Promise<JobRecord[]>;
    cancel(id: string): Promise<void>;
    drainForeground(maxJobsPerForegroundWindow: number): Promise<ForegroundDrainOutcome>;
    stop(): void;
    start(): void;
    isActive(): boolean;
  };
  tabs: TabFeatureServices;
  dispose(): void;
}

export interface BootAttemptResult {
  boot: BootState;
  composition: AppServiceComposition | null;
}

export type AppBootstrap = () => Promise<AppServiceComposition>;

export const TAB_FEATURE_SERVICE_KEYS: ReadonlyArray<TabFeatureServiceKey> = [
  'receipts',
  'purchases',
  'scan',
  'collections',
  'settings',
];

type AppServices = {
  boot: BootState;
  composition: AppServiceComposition | null;
  retryBoot: () => void;
};

const AppServicesContext = createContext<AppServices | null>(null);

class MemoryScanStaging implements ScanStagingPort {
  private readonly descriptors = new Map<string, ScanStagedDescriptor>();

  async put(descriptor: ScanStagedDescriptor): Promise<void> {
    this.descriptors.set(descriptor.id, descriptor);
  }

  async remove(stageId: string): Promise<void> {
    this.descriptors.delete(stageId);
  }

  async list(): Promise<ScanStagedDescriptor[]> {
    return [...this.descriptors.values()];
  }
}

function createSettingsController(input: {
  secureCredentials: SecureCredentialsPort;
  pairingCredentials: { get(): Promise<{ token: string | null; accountId: string | null }> };
  initialPairing: {
    serverUrl: string;
    deviceName: string;
    paired: boolean;
    accountHint: string | null;
  };
  initialSync: {
    autoSync: boolean;
    wifiOnly: boolean;
  };
  persistSyncConfig: (patch: { serverUrl?: string; autoSync?: boolean; wifiOnly?: boolean; deviceName?: string }) => Promise<void>;
}): SettingsFeatureController {
  return new SettingsFeatureController({
    pairing: {
      serverUrl: input.initialPairing.serverUrl,
      paired: input.initialPairing.paired,
      deviceName: input.initialPairing.deviceName,
      accountHint: input.initialPairing.accountHint,
    },
    image: {
      autoCapture: true,
      jpegQuality: 0.9,
      colorMode: 'grayscale',
    },
    ocr: {
      languages: ['sv-SE', 'en-US'],
      languageCorrection: true,
    },
    ai: {
      mode: 'remote',
      provider: 'openai',
      model: 'gpt-4.1-mini',
    },
    sync: {
      autoSync: input.initialSync.autoSync,
      wifiOnly: input.initialSync.wifiOnly,
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
      appVersion: '0.1.0-preview',
      nativeVersion: 'wave-3-js-integration',
    },
    secureCredentials: input.secureCredentials,
    pairingCredentials: input.pairingCredentials,
    persistence: {
      onSyncChanged(next) {
        return input.persistSyncConfig(next);
      },
      onPairingChanged(next) {
        return input.persistSyncConfig({
          serverUrl: next.serverUrl,
          deviceName: next.deviceName,
        });
      },
    },
    diagnostics: {
      async read() {
        return {
          storage: 'expo-sqlite-sqlcipher',
          sync: 'not-paired',
          native: 'module-linked-at-runtime',
        };
      },
    },
  });
}

function createExpoSecureStoreBackend(): SecureStoreBackend {
  return {
    getItem(name) {
      return SecureStore.getItemAsync(name);
    },
    async setItem(name, value, options) {
      await SecureStore.setItemAsync(name, value, {
        keychainAccessible: options?.keychainAccessible as SecureStore.KeychainAccessibilityConstant | undefined,
      });
    },
    async deleteItem(name) {
      await SecureStore.deleteItemAsync(name);
    },
    whenUnlockedThisDeviceOnly: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

function unsupportedFrame(): FrameAnalysisResult {
  return {
    status: 'unsupported',
    pluginLinked: false,
    evidenceScore: 0,
    coverage: 0,
    normalizedQuad: null,
    source: 'stub',
    timing: {
      startedAtMs: Date.now(),
      endedAtMs: Date.now(),
      durationMs: 0,
    },
  };
}

function createScanController(repository: IosDataRepository, native: KvittoNativeFacade, jobs: ScanJobQueuePort): ScanFeatureController {
  const camera: ScanCameraPort = {
    async requestPermission() {
      return 'unavailable';
    },
    async startPreview() {
      return;
    },
    async stopPreview() {
      return;
    },
    async captureStill() {
      throw new Error('Camera adapter has not been wired yet in this JS integration wave.');
    },
    async analyzeFrameCompact() {
      return unsupportedFrame();
    },
  };

  const library: ScanLibraryPort = {
    async pickImages() {
      return [];
    },
  };

  const haptics: ScanHapticsPort = {
    impact() {
      return;
    },
  };

  return createScanFeatureController({
    native,
    camera,
    library,
    haptics,
    staging: new MemoryScanStaging(),
    jobs,
    repo: repository,
    paths: {
      tempUri(kind, stageId) {
        return `file:///tmp/${stageId}-${kind}.jpg`;
      },
    },
  });
}

function createBlobFilePort(native: KvittoNativeFacade): BlobFilePort {
  return {
    async getUploadDescriptor(id) {
      const record = await native.getBlobMetadata(id);
      if (!record) {
        throw new Error(`Blob metadata is missing for upload id ${id}.`);
      }
      return {
        id,
        mimeType: record.mimeType,
        filePath: record.uri,
      };
    },
    async readFile(path) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Could not read blob file for sync upload (${path}).`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeDownloadedBlob() {
      throw new Error('Blob download persistence is not yet available in app-level sync composition.');
    },
  };
}

function createRepositoryIdentityStateStore(repository: IosDataRepository): IdentityStateStore {
  return createIdentityStateStoreFromKeyValue({
    getKeyValue(key) {
      return repository.getKeyValue(key);
    },
    setKeyValue(key, value) {
      return repository.setKeyValue(key, value);
    },
    deleteKeyValue(key) {
      return repository.deleteKeyValue(key);
    },
  });
}

export function composeTabFeatureServices(input: {
  repository: IosDataRepository;
  scanController: ScanFeatureController;
  settingsController: SettingsFeatureController;
}): TabFeatureServices {
  return {
    receipts: { repository: input.repository },
    purchases: { repository: input.repository },
    scan: { controller: input.scanController },
    collections: { repository: input.repository },
    settings: { controller: input.settingsController },
  };
}

export async function bootstrapProductionAppServices(): Promise<AppServiceComposition> {
  if ((globalThis as { __KVITTO_FORCE_BOOT_ERROR__?: boolean }).__KVITTO_FORCE_BOOT_ERROR__) {
    throw new Error('Boot diagnostics mode triggered by __KVITTO_FORCE_BOOT_ERROR__.');
  }

  const productionFoundation = await startProductionDataFoundation();
  const repository = productionFoundation.repository;
  const startup = productionFoundation.startup;

  const stateStore = createRepositoryIdentityStateStore(repository);
  const syncConfigStore = createSyncConfigStore({
    state: stateStore,
    defaults: {
      serverUrl: '',
      autoSync: true,
      wifiOnly: true,
    },
  });

  const native = createKvittoNativeFacade();
  const blobStore = new IosNativeBlobStore(native);
  const blobFiles = createBlobFilePort(native);

  const secureCredentialPorts = createSecureStoreCredentialPorts(createExpoSecureStoreBackend());
  const syncService = await createAppSyncService({
    repository,
    state: stateStore,
    tokenVault: secureCredentialPorts.pairingTokenVault,
    configStore: syncConfigStore,
    blobs: blobStore,
    blobFiles,
    transportFactory(options) {
      return new ProtocolV2Transport(options);
    },
    engineOptions: {
      runOptions: {
        blobDownloadLimit: 0,
      },
    },
    now: () => Date.now(),
  });

  const credentials = createCredentialsAdapter({
    state: stateStore,
    tokenVault: secureCredentialPorts.pairingTokenVault,
  });

  const syncSnapshot = syncService.getSnapshot();

  const durableJobStore = createRepositoryBackedJobStore({
    repository,
    clock: { now: () => Date.now() },
  });
  const runOneScanJob = createScanDurableRunOne({
    store: durableJobStore,
    repository,
    native,
    clock: { now: () => Date.now() },
  });
  const jobService = createScanDurableJobService({
    store: durableJobStore,
    clock: { now: () => Date.now() },
    runOne: runOneScanJob,
  });

  const scanController = createScanController(repository, native, jobService.queue);
  await scanController.syncRecoverableStages();
  const settingsController = createSettingsController({
    secureCredentials: secureCredentialPorts.settingsCredentials,
    pairingCredentials: credentials,
    initialPairing: {
      serverUrl: syncSnapshot.config.serverUrl,
      paired: syncSnapshot.paired,
      deviceName: syncSnapshot.deviceName,
      accountHint: syncSnapshot.accountHint,
    },
    initialSync: {
      autoSync: syncSnapshot.config.autoSync,
      wifiOnly: syncSnapshot.config.wifiOnly,
    },
    persistSyncConfig(patch) {
      return syncService.updateConfig(patch);
    },
  });

  return {
    startup,
    repository,
    sync: syncService,
    jobs: jobService,
    tabs: composeTabFeatureServices({
      repository,
      scanController,
      settingsController,
    }),
    dispose() {
      jobService.stop();
      syncService.dispose();
    },
  };
}

export async function runBootAttempt(bootstrap: AppBootstrap): Promise<BootAttemptResult> {
  try {
    const composition = await bootstrap();
    return {
      boot: bootReady(),
      composition,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown startup error.';
    return {
      boot: bootFailed('Could not initialize local services.', details),
      composition: null,
    };
  }
}

type AppServicesProviderProps = {
  children: ReactNode;
  bootstrap?: AppBootstrap;
};

export function AppServicesProvider({ children, bootstrap = bootstrapProductionAppServices }: AppServicesProviderProps) {
  const [boot, setBoot] = useState<BootState>(initialBootState);
  const [composition, setComposition] = useState<AppServiceComposition | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setBoot(initialBootState);
    setComposition(null);

    runBootAttempt(bootstrap).then((result) => {
      if (cancelled) {
        result.composition?.dispose();
        return;
      }
      setBoot(result.boot);
      setComposition(result.composition);
    });

    return () => {
      cancelled = true;
    };
  }, [bootAttempt, bootstrap]);

  useEffect(() => {
    return () => {
      composition?.dispose();
    };
  }, [composition]);

  const value = useMemo<AppServices>(
    () => ({
      boot,
      composition,
      retryBoot: () => {
        setBootAttempt((previous) => previous + 1);
      },
    }),
    [boot, composition],
  );

  return <AppServicesContext.Provider value={value}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const context = useContext(AppServicesContext);

  if (!context) {
    throw new Error('useAppServices must be used inside AppServicesProvider.');
  }

  return context;
}
