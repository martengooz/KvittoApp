import { newId, type ID } from '@kvitto/shared/domain';
import type { CanonicalRepositoryPort, CredentialsPort, CredentialState, Logger } from '@kvitto/client-core/ports';

const DEVICE_ID_KEY = 'sync.deviceId';
const DEVICE_NAME_KEY = 'sync.deviceName';
const ACCOUNT_ID_KEY = 'sync.accountId';

export interface IdentityStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface IdentityKeyValuePort {
  getKeyValue(key: string): Promise<string | null>;
  setKeyValue(key: string, value: string): Promise<void>;
  deleteKeyValue(key: string): Promise<void>;
}

export interface TokenVault {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface IdentityDeps {
  state: IdentityStateStore;
  tokenVault: TokenVault;
  idFactory?: () => ID;
  deviceNameFactory?: () => string;
}

export function createIdentityStateStoreFromKeyValue(port: IdentityKeyValuePort): IdentityStateStore {
  return {
    get(key) {
      return port.getKeyValue(key);
    },
    set(key, value) {
      return port.setKeyValue(key, value);
    },
    remove(key) {
      return port.deleteKeyValue(key);
    },
  };
}

export function createCredentialsAdapter(deps: IdentityDeps): CredentialsPort {
  return {
    async get(): Promise<CredentialState> {
      const [deviceId, accountId, token] = await Promise.all([
        deps.state.get(DEVICE_ID_KEY),
        deps.state.get(ACCOUNT_ID_KEY),
        deps.tokenVault.get(),
      ]);

      return {
        deviceId,
        accountId,
        token,
      };
    },

    async set(next: CredentialState): Promise<void> {
      if (next.deviceId) await deps.state.set(DEVICE_ID_KEY, next.deviceId);
      else await deps.state.remove(DEVICE_ID_KEY);

      if (next.accountId) await deps.state.set(ACCOUNT_ID_KEY, next.accountId);
      else await deps.state.remove(ACCOUNT_ID_KEY);

      if (next.token) await deps.tokenVault.set(next.token);
      else await deps.tokenVault.clear();
    },

    async clear(): Promise<void> {
      await Promise.all([
        deps.state.remove(ACCOUNT_ID_KEY),
        deps.tokenVault.clear(),
      ]);
    },
  };
}

export async function getOrCreateDeviceId(deps: IdentityDeps): Promise<ID> {
  const existing = await deps.state.get(DEVICE_ID_KEY);
  if (existing) return existing;

  const generated = deps.idFactory?.() ?? newId();
  await deps.state.set(DEVICE_ID_KEY, generated);
  return generated;
}

export async function getDeviceName(deps: IdentityDeps): Promise<string> {
  const existing = await deps.state.get(DEVICE_NAME_KEY);
  if (existing && existing.trim().length > 0) return existing;

  const fallback = deps.deviceNameFactory?.() ?? 'iPhone';
  await deps.state.set(DEVICE_NAME_KEY, fallback);
  return fallback;
}

export async function setDeviceName(deps: IdentityDeps, name: string): Promise<void> {
  const trimmed = name.trim();
  await deps.state.set(DEVICE_NAME_KEY, trimmed.length > 0 ? trimmed : deps.deviceNameFactory?.() ?? 'iPhone');
}

export interface UnpairDeps {
  credentials: CredentialsPort;
  repo: Pick<CanonicalRepositoryPort, 'dirtyAllAndResetRev' | 'setSyncState'>;
  resetBlobUploadState: () => Promise<void>;
  logger?: Logger;
}

export async function unpairDevice(deps: UnpairDeps): Promise<void> {
  await deps.credentials.clear();
  await deps.repo.setSyncState({ cursor: 0, epoch: 'unpaired' });
  await deps.repo.dirtyAllAndResetRev();
  await deps.resetBlobUploadState();

  deps.logger?.info('sync.unpair', {
    cursor: 0,
    token: '[redacted]',
    accountId: '[redacted]',
    dirtyAll: true,
    resetUploads: true,
  });
}
