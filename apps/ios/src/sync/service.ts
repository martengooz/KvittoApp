import type { BlobStorePort, CanonicalRepositoryPort, Clock, Logger, NetworkPort } from '@kvitto/client-core/ports';
import type { SyncRunResult } from '@kvitto/client-core/sync';
import type { PairResponse } from '@kvitto/shared/domain';

import { createIosSyncEngine, type IosSyncEngine, type IosSyncEngineOptions } from './engine';
import {
  createCredentialsAdapter,
  getDeviceName,
  getOrCreateDeviceId,
  setDeviceName,
  type IdentityDeps,
  type IdentityStateStore,
  type TokenVault,
  unpairDevice,
} from './identity';
import { ProtocolV2Transport, type BlobFilePort, type ProtocolV2TransportOptions } from './transport/client';
import type { PersistedSyncConfig, SyncConfigStore } from './config';

export interface AppSyncServiceSnapshot {
  config: PersistedSyncConfig;
  paired: boolean;
  accountHint: string | null;
  deviceName: string;
  engine: ReturnType<IosSyncEngine['getSnapshot']>;
}

export interface AppSyncService {
  getSnapshot(): AppSyncServiceSnapshot;
  subscribe(listener: () => void): () => void;
  runManual(reason?: string): Promise<SyncRunResult>;
  pair(code: string): Promise<PairResponse>;
  unpair(): Promise<void>;
  updateConfig(patch: Partial<PersistedSyncConfig & { deviceName: string }>): Promise<void>;
  dispose(): void;
}

export interface CreateAppSyncServiceInput {
  repository: CanonicalRepositoryPort;
  state: IdentityStateStore;
  tokenVault: TokenVault;
  configStore: SyncConfigStore;
  blobs: BlobStorePort;
  blobFiles: BlobFilePort;
  logger?: Logger;
  network?: NetworkPort;
  clock?: Clock;
  now?: () => number;
  engineOptions?: IosSyncEngineOptions;
  transportFactory?: (options: ProtocolV2TransportOptions) => ProtocolV2Transport;
  idFactory?: IdentityDeps['idFactory'];
  deviceNameFactory?: IdentityDeps['deviceNameFactory'];
}

export async function createAppSyncService(input: CreateAppSyncServiceInput): Promise<AppSyncService> {
  const logger = input.logger ?? silentLogger;
  const network = input.network ?? { isOnline: () => true };
  const clock = input.clock ?? { now: () => Date.now() };
  const transportFactory = input.transportFactory ?? ((options) => new ProtocolV2Transport(options));

  const credentials = createCredentialsAdapter({
    state: input.state,
    tokenVault: input.tokenVault,
    idFactory: input.idFactory,
    deviceNameFactory: input.deviceNameFactory,
  });

  let config = await input.configStore.read();
  let deviceName = await getDeviceName({
    state: input.state,
    tokenVault: input.tokenVault,
    deviceNameFactory: input.deviceNameFactory,
  });
  await getOrCreateDeviceId({
    state: input.state,
    tokenVault: input.tokenVault,
    idFactory: input.idFactory,
  });
  let authState = await readSnapshotAuthState();

  let transport = createTransport();
  let engine = createEngine();
  let disposed = false;

  const listeners = new Set<() => void>();
  let detachEngine = engine.subscribe(() => {
    notify();
  });

  function createTransport(): ProtocolV2Transport {
    return transportFactory({
      serverUrl: config.serverUrl || 'http://127.0.0.1.invalid',
      credentials,
      deviceIdentity: {
        getDeviceId: () => getOrCreateDeviceId({ state: input.state, tokenVault: input.tokenVault, idFactory: input.idFactory }),
        getDeviceName: () => getDeviceName({ state: input.state, tokenVault: input.tokenVault, deviceNameFactory: input.deviceNameFactory }),
      },
      blobFiles: input.blobFiles,
      logger,
    });
  }

  function createEngine(): IosSyncEngine {
    return createIosSyncEngine({
      repo: input.repository,
      transport,
      blobs: input.blobs,
      clock,
      logger,
      network,
    }, {
      now: input.now,
      ...input.engineOptions,
    });
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function readSnapshotAuthState(): Promise<{ paired: boolean; accountHint: string | null }> {
    const state = await credentials.get();
    return {
      paired: Boolean(state.token),
      accountHint: state.accountId,
    };
  }

  async function rotateEngineIfNeeded(nextConfig: PersistedSyncConfig): Promise<void> {
    if (nextConfig.serverUrl === config.serverUrl) {
      config = nextConfig;
      return;
    }

    config = nextConfig;
    const previousEngine = engine;
    detachEngine();
    previousEngine.dispose();

    transport = createTransport();
    engine = createEngine();
    detachEngine = engine.subscribe(() => {
      notify();
    });
  }

  return {
    getSnapshot(): AppSyncServiceSnapshot {
      const state = engine.getSnapshot();
      return {
        config,
        paired: authState.paired,
        accountHint: authState.accountHint,
        deviceName,
        engine: state,
      };
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async runManual(reason = 'manual'): Promise<SyncRunResult> {
      if (disposed) throw new Error('Sync service is disposed.');
      if (!config.serverUrl) {
        throw new Error('Sync server URL is required before running sync.');
      }
      return engine.run(reason);
    },

    async pair(code: string): Promise<PairResponse> {
      if (disposed) throw new Error('Sync service is disposed.');
      if (!config.serverUrl) {
        throw new Error('Sync server URL is required before pairing.');
      }

      const response = await transport.pairCurrentDevice(code);
      authState = await readSnapshotAuthState();
      notify();
      return response;
    },

    async unpair(): Promise<void> {
      if (disposed) throw new Error('Sync service is disposed.');

      await unpairDevice({
        credentials,
        repo: input.repository,
        resetBlobUploadState: async () => {},
        logger,
      });
      authState = await readSnapshotAuthState();
      notify();
    },

    async updateConfig(patch): Promise<void> {
      if (disposed) throw new Error('Sync service is disposed.');

      if (patch.deviceName !== undefined) {
        await setDeviceName({
          state: input.state,
          tokenVault: input.tokenVault,
          deviceNameFactory: input.deviceNameFactory,
        }, patch.deviceName);
        deviceName = await getDeviceName({
          state: input.state,
          tokenVault: input.tokenVault,
          deviceNameFactory: input.deviceNameFactory,
        });
      }

      const nextConfig = await input.configStore.write({
        serverUrl: patch.serverUrl,
        autoSync: patch.autoSync,
        wifiOnly: patch.wifiOnly,
      });

      await rotateEngineIfNeeded(nextConfig);
      notify();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      detachEngine();
      engine.dispose();
      listeners.clear();
    },
  };
}

export function createUnsupportedBlobDownloadWriter(): Pick<BlobFilePort, 'writeDownloadedBlob'> {
  return {
    async writeDownloadedBlob(): Promise<void> {
      throw new Error('Blob download persistence is unavailable in this app-level sync composition step.');
    },
  };
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
