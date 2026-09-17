import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';

import {
  createKvittoNativeFacade,
  type FileBackedDescriptor,
  type KvittoNativeFacade,
} from '../../modules/kvitto-native/src';
import {
  createSecureStoreCredentialPorts,
  IosNativeBlobStore,
  IosDataRepository,
  startProductionDataFoundation,
  type SecureStoreBackend,
  type DataStartupResult,
} from '../data';
import {
  createScanCameraBridge,
  createScanFeatureController,
  type ScanCameraBridge,
  type ScanFeatureController,
} from '../features/scan';
import type {
  ScanCameraPort,
  ScanHapticsPort,
  ScanJobQueuePort,
  ScanLibraryPort,
  ScanStagedDescriptor,
  ScanStagingPort,
} from '../features/scan/types';
import { createReceiptFilterStore, type ReceiptFilterStore } from '../features/receipts/filter-store';
import { SettingsFeatureController, type SecureCredentialsPort } from '../features/settings';
import { createBlobFilePort, createBlobRoleRegistry } from '../sync/blob-files';
import { createSyncConfigStore } from '../sync/config';
import { createReceiptImagePlanner } from '../sync/image-planner';
import { createExpoNetworkBackend, createIosNetworkMonitor } from '../sync/network';
import { createIosSyncTriggers, createReactNativeAppLifecycle } from '../sync/triggers';
import { createCredentialsAdapter, createIdentityStateStoreFromKeyValue, type IdentityStateStore } from '../sync/identity';
import { createAppSyncService, type AppSyncService } from '../sync/service';
import { ProtocolV2Transport } from '../sync/transport/client';
import { createVisionCameraPermissionsPort } from './camera-platform';
import {
  createRepositoryBackedJobStore,
  createScanDurableJobService,
  createScanDurableRunOne,
  type ForegroundDrainOutcome,
} from '../jobs';
import type { JobRecord, JobState } from '@kvitto/client-core/ports';
import { bootFailed, bootReady, initialBootState, type BootState } from './boot-state';

export interface TabFeatureServices {
  receipts: { repository: IosDataRepository; filters: ReceiptFilterStore };
  purchases: { repository: IosDataRepository };
  scan: { controller: ScanFeatureController; camera: ScanCameraBridge; native: KvittoNativeFacade };
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

/**
 * Turns a file the camera or photo library produced into the descriptor the
 * scan pipeline works with, hashing it so it is content-addressable from the
 * first moment it exists.
 */
async function describeImageFile(
  native: KvittoNativeFacade,
  file: { uri: string; width: number; height: number; byteSize: number },
): Promise<FileBackedDescriptor> {
  return {
    uri: file.uri,
    mimeType: 'image/jpeg',
    width: file.width,
    height: file.height,
    byteSize: file.byteSize,
    sha256Id: await native.hashFileSha256(file.uri),
    role: 'original',
  };
}

function createPhotoLibraryPort(native: KvittoNativeFacade): ScanLibraryPort {
  return {
    async pickImages(): Promise<FileBackedDescriptor[]> {
      const picker = await import('expo-image-picker');
      const permission = await picker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Photo library access is needed to import receipt images.');
      }

      const result = await picker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 1,
        exif: false,
      });
      if (result.canceled) return [];

      const descriptors: FileBackedDescriptor[] = [];
      for (const asset of result.assets) {
        descriptors.push(
          await describeImageFile(native, {
            uri: asset.uri,
            width: asset.width,
            height: asset.height,
            byteSize: asset.fileSize ?? 0,
          }),
        );
      }
      return descriptors;
    },
  };
}

function createScanController(
  repository: IosDataRepository,
  native: KvittoNativeFacade,
  jobs: ScanJobQueuePort,
  camera: ScanCameraPort,
): ScanFeatureController {
  const library = createPhotoLibraryPort(native);

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
        return native.makeScratchFileUri(`${stageId}-${kind}`, 'jpg');
      },
    },
  });
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
  receiptFilters?: ReceiptFilterStore;
  scanController: ScanFeatureController;
  scanCamera: ScanCameraBridge;
  native: KvittoNativeFacade;
  settingsController: SettingsFeatureController;
}): TabFeatureServices {
  return {
    receipts: {
      repository: input.repository,
      // Shared so the filters modal and the list agree; see filter-store.ts.
      filters: input.receiptFilters ?? createReceiptFilterStore(),
    },
    purchases: { repository: input.repository },
    scan: { controller: input.scanController, camera: input.scanCamera, native: input.native },
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
  const blobRoles = createBlobRoleRegistry();
  const blobFiles = createBlobFilePort({ native, roles: blobRoles });

  const networkMonitor = createIosNetworkMonitor({ backend: createExpoNetworkBackend() });
  await networkMonitor.refresh();

  // The trigger policy reads the live service snapshot, so settings changes and
  // pairing take effect without rebuilding the triggers. Triggers only fire on
  // events after boot, by which point the reference is set.
  let syncServiceRef: AppSyncService | null = null;
  const syncTriggers = createIosSyncTriggers({
    lifecycle: createReactNativeAppLifecycle(),
    network: networkMonitor,
    localChanges: {
      subscribe: (listener) => repository.subscribe(() => listener()),
    },
    policy: () => {
      const snapshot = syncServiceRef?.getSnapshot();
      return {
        autoSync: snapshot?.config.autoSync ?? false,
        wifiOnly: snapshot?.config.wifiOnly ?? true,
        ready: Boolean(snapshot?.config.serverUrl) && Boolean(snapshot?.paired),
      };
    },
  });

  const secureCredentialPorts = createSecureStoreCredentialPorts(createExpoSecureStoreBackend());
  const syncService = await createAppSyncService({
    repository,
    state: stateStore,
    tokenVault: secureCredentialPorts.pairingTokenVault,
    configStore: syncConfigStore,
    blobs: blobStore,
    blobFiles,
    network: networkMonitor,
    triggers: syncTriggers,
    imagePlanner: createReceiptImagePlanner({
      repository,
      roles: blobRoles,
      hasBlob: async (id) => (await native.getBlobMetadata(id)) !== null,
    }),
    async resetBlobUploadState() {
      await native.resetBlobUploadState();
    },
    transportFactory(options) {
      return new ProtocolV2Transport(options);
    },
    engineOptions: {
      runOptions: {
        blobDownloadLimit: 24,
      },
    },
    now: () => Date.now(),
  });
  syncServiceRef = syncService;

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

  const scanCamera = createScanCameraBridge({
    permissions: createVisionCameraPermissionsPort(),
    describeCapture: (capture) => describeImageFile(native, capture),
  });
  const scanController = createScanController(repository, native, jobService.queue, scanCamera);
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
      scanCamera,
      native,
      settingsController,
    }),
    dispose() {
      jobService.stop();
      syncService.dispose();
      networkMonitor.dispose();
    },
  };
}

/** Markers the device smoke check waits for; see `apps/ios/scripts/smoke.mjs`. */
export const BOOT_READY_MARKER = 'boot:ready';
export const BOOT_FAILED_MARKER = 'boot:failed';

/**
 * Boot outcome goes to the unified log as well as to React state, because a
 * Release build strips `console`, and a screenshot cannot tell a rendered shell
 * apart from a rendered error card. Automation needs one unambiguous signal.
 */
function reportBootOutcome(marker: string, detail: string): void {
  try {
    createKvittoNativeFacade().logDiagnostic(marker, detail);
  } catch {
    // The native module is unavailable off-device; boot state still carries the
    // outcome for anything running in-process.
  }
}

export async function runBootAttempt(bootstrap: AppBootstrap): Promise<BootAttemptResult> {
  try {
    const composition = await bootstrap();
    reportBootOutcome(BOOT_READY_MARKER, `steps=${composition.startup.steps.length}`);
    return {
      boot: bootReady(),
      composition,
    };
  } catch (error) {
    const details = error instanceof Error ? error.message : 'Unknown startup error.';
    reportBootOutcome(BOOT_FAILED_MARKER, details);
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
