/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import type { BlobDescriptor, BlobStorePort } from '@kvitto/client-core/ports';
import type { PairResponse } from '@kvitto/shared/domain';

import { createSecureStoreCredentialPorts, type SecureStoreBackend } from '../src/data/secure-credentials';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { createSyncConfigStore } from '../src/sync/config';
import { createIdentityStateStoreFromKeyValue, createCredentialsAdapter } from '../src/sync/identity';
import { createAppSyncService } from '../src/sync/service';
import { ProtocolV2Transport, type BlobFilePort } from '../src/sync/transport/client';

class InMemorySecureStoreBackend implements SecureStoreBackend {
  readonly whenUnlockedThisDeviceOnly = 'WHEN_UNLOCKED_THIS_DEVICE_ONLY';

  constructor(private readonly map: Map<string, string> = new Map()) {}

  async getItem(name: string): Promise<string | null> {
    return this.map.get(name) ?? null;
  }

  async setItem(name: string, value: string): Promise<void> {
    this.map.set(name, value);
  }

  async deleteItem(name: string): Promise<void> {
    this.map.delete(name);
  }
}

class BlobStoreStub implements BlobStorePort {
  readonly pending = new Map<string, BlobDescriptor>();
  markUploadedCalls = 0;

  constructor() {
    this.pending.set('blob-1', {
      id: 'blob-1',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      size: 3,
      role: 'thumb',
      createdAt: 1,
    });
  }

  async put(descriptor: Omit<BlobDescriptor, 'createdAt'>): Promise<BlobDescriptor> {
    const next: BlobDescriptor = { ...descriptor, createdAt: 1 };
    this.pending.set(next.id, next);
    return next;
  }

  async get(id: string): Promise<BlobDescriptor | null> {
    return this.pending.get(id) ?? null;
  }

  async markUploaded(id: string): Promise<void> {
    this.markUploadedCalls += 1;
    this.pending.delete(id);
  }

  async listPendingUpload(limit: number): Promise<BlobDescriptor[]> {
    return [...this.pending.values()].slice(0, limit);
  }
}

function createBlobFilePort(): BlobFilePort {
  return {
    async getUploadDescriptor(id) {
      return {
        id,
        mimeType: 'image/jpeg',
        filePath: '/tmp/fake.jpg',
      };
    },
    async readFile() {
      return new Uint8Array([1, 2, 3]);
    },
    async writeDownloadedBlob() {
      throw new Error('not implemented in test');
    },
  };
}

type BackendState = {
  statusCalls: number;
  pairCalls: number;
};

function createTransport(state: BackendState) {
  return (options: ConstructorParameters<typeof ProtocolV2Transport>[0]) => {
    const fetchImpl: NonNullable<ConstructorParameters<typeof ProtocolV2Transport>[0]['fetchImpl']> = async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? 'GET';

      if (method === 'POST' && path === '/auth/pair') {
        state.pairCalls += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as { deviceId: string; deviceName: string };
        const response: PairResponse = {
          token: `pair-token-${state.pairCalls}`,
          accountId: 'acc-123',
          deviceId: body.deviceId,
          deviceName: body.deviceName,
          protocolVersion: 2,
          serverTime: Date.now(),
        };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'GET' && path === '/sync/status') {
        state.statusCalls += 1;
        return new Response(JSON.stringify({
          cursor: 0,
          epoch: 'epoch-1',
          hasChanges: false,
          diverged: false,
          serverTime: Date.now(),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'GET' && path === '/sync/pull') {
        return new Response(JSON.stringify({
          changes: {},
          cursor: 0,
          hasMore: false,
          epoch: 'epoch-1',
          serverTime: Date.now(),
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && path === '/sync/push') {
        return new Response(JSON.stringify({ results: [], cursor: 0, serverTime: Date.now() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && path === '/blobs/status') {
        return new Response(JSON.stringify({ missing: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    return new ProtocolV2Transport({
      ...options,
      fetchImpl,
    });
  };
}

function createSetup() {
  const repository = new IosDataRepository(new SqliteTestAdapter(), () => 1234);
  const stateStore = createIdentityStateStoreFromKeyValue({
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

  return {
    repository,
    stateStore,
    configStore: createSyncConfigStore({ state: stateStore }),
  };
}

describe('app sync service composition', () => {
  test('persists non-secret sync config across composition recreation', async () => {
    const base = createSetup();
    const secureStore = new InMemorySecureStoreBackend();
    const ports = createSecureStoreCredentialPorts(secureStore);

    const serviceA = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: ports.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'This iPhone',
    });

    await serviceA.updateConfig({
      serverUrl: 'https://sync.example',
      autoSync: false,
      wifiOnly: false,
      deviceName: 'Martens iPhone',
    });
    serviceA.dispose();

    const serviceB = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: ports.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'This iPhone',
    });

    const snapshot = serviceB.getSnapshot();
    expect(snapshot.config).toEqual({
      serverUrl: 'https://sync.example',
      autoSync: false,
      wifiOnly: false,
    });
    expect(snapshot.deviceName).toBe('Martens iPhone');
    serviceB.dispose();
  });

  test('shares token source between settings secure credentials and pairing transport', async () => {
    const base = createSetup();
    const secureStore = new InMemorySecureStoreBackend();
    const ports = createSecureStoreCredentialPorts(secureStore);

    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: ports.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'Test iPhone',
    });

    await service.updateConfig({ serverUrl: 'https://sync.example' });
    await service.pair('PAIR-OK');

    const credentials = createCredentialsAdapter({
      state: base.stateStore,
      tokenVault: ports.pairingTokenVault,
    });

    await expect(ports.settingsCredentials.get()).resolves.toMatchObject({
      pairingToken: 'pair-token-1',
    });
    await expect(credentials.get()).resolves.toMatchObject({
      token: 'pair-token-1',
      accountId: 'acc-123',
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.paired).toBe(true);
    expect(snapshot.accountHint).toBe('acc-123');

    service.dispose();
  });

  test('manual run delegates to engine and coalesces concurrent passes', async () => {
    const base = createSetup();
    const ports = createSecureStoreCredentialPorts(new InMemorySecureStoreBackend());
    const backend = { statusCalls: 0, pairCalls: 0 };

    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: ports.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport(backend),
      deviceNameFactory: () => 'Test iPhone',
    });

    await service.updateConfig({ serverUrl: 'https://sync.example' });
    await service.pair('PAIR-OK');

    await Promise.all([
      service.runManual('manual-1'),
      service.runManual('manual-2'),
    ]);

    expect(backend.statusCalls).toBe(1);
    service.dispose();
  });

  test('unpair clears token/account, resets sync cursor, and dirties repository', async () => {
    const base = createSetup();
    const securePorts = createSecureStoreCredentialPorts(new InMemorySecureStoreBackend());
    const blobs = new BlobStoreStub();

    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: securePorts.pairingTokenVault,
      configStore: base.configStore,
      blobs,
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'Test iPhone',
    });

    await service.updateConfig({ serverUrl: 'https://sync.example' });
    await base.repository.createReceipt({ id: 'receipt-1' });
    await service.pair('PAIR-OK');
    await service.unpair();

    const credentials = createCredentialsAdapter({
      state: base.stateStore,
      tokenVault: securePorts.pairingTokenVault,
    });

    await expect(credentials.get()).resolves.toEqual({
      deviceId: expect.any(String),
      accountId: null,
      token: null,
    });
    await expect(base.repository.getSyncState()).resolves.toEqual({ cursor: 0, epoch: 'unpaired' });
    await expect(base.repository.countDirty()).resolves.toBeGreaterThan(0);
    expect(blobs.markUploadedCalls).toBe(0);
    await expect(blobs.listPendingUpload(10)).resolves.toHaveLength(1);

    service.dispose();
  });

  test('dispose is idempotent, clears listeners, and blocks later runs', async () => {
    const base = createSetup();
    const securePorts = createSecureStoreCredentialPorts(new InMemorySecureStoreBackend());
    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: securePorts.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'Test iPhone',
    });
    const listener = jest.fn();
    service.subscribe(listener);

    service.dispose();
    service.dispose();

    await expect(service.runManual()).rejects.toThrow('Sync service is disposed.');
    expect(listener).not.toHaveBeenCalled();
  });
  test('unpair marks locally stored blobs for upload to the next account', async () => {
    const base = createSetup();
    const securePorts = createSecureStoreCredentialPorts(new InMemorySecureStoreBackend());
    let resetCalls = 0;

    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: securePorts.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport({ statusCalls: 0, pairCalls: 0 }),
      deviceNameFactory: () => 'Test iPhone',
      async resetBlobUploadState() {
        resetCalls += 1;
      },
    });

    await service.updateConfig({ serverUrl: 'https://sync.example' });
    await service.pair('PAIR-OK');
    await service.unpair();

    expect(resetCalls).toBe(1);
    service.dispose();
  });

  test('an attached trigger drives a sync run and detaches on dispose', async () => {
    const base = createSetup();
    const securePorts = createSecureStoreCredentialPorts(new InMemorySecureStoreBackend());
    const backend = { statusCalls: 0, pairCalls: 0 };

    let fire: ((reason: string) => void) | null = null;
    let detached = false;

    const service = await createAppSyncService({
      repository: base.repository,
      state: base.stateStore,
      tokenVault: securePorts.pairingTokenVault,
      configStore: base.configStore,
      blobs: new BlobStoreStub(),
      blobFiles: createBlobFilePort(),
      transportFactory: createTransport(backend),
      deviceNameFactory: () => 'Test iPhone',
      triggers: {
        attach(trigger) {
          fire = trigger;
          return () => {
            detached = true;
          };
        },
      },
    });

    await service.updateConfig({ serverUrl: 'https://sync.example' });
    await service.pair('PAIR-OK');

    expect(fire).not.toBeNull();
    fire!('foreground');
    await new Promise((resolve) => setImmediate(resolve));

    expect(backend.statusCalls).toBeGreaterThan(0);
    expect(service.getSnapshot().engine.lastSuccessAt).not.toBeNull();

    service.dispose();
    expect(detached).toBe(true);
  });
});
