/** @jest-environment node */

import { createCredentialsAdapter, getDeviceName, getOrCreateDeviceId, setDeviceName, type IdentityStateStore, type TokenVault } from '../src/sync/identity';

class MemoryStateStore implements IdentityStateStore {
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

class MemoryTokenVault implements TokenVault {
  token: string | null = null;

  async get(): Promise<string | null> {
    return this.token;
  }

  async set(token: string): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}

describe('sync identity', () => {
  test('keeps stable generated device id', async () => {
    const state = new MemoryStateStore();
    const tokenVault = new MemoryTokenVault();

    const first = await getOrCreateDeviceId({ state, tokenVault, idFactory: () => 'generated-id-1' });
    const second = await getOrCreateDeviceId({ state, tokenVault, idFactory: () => 'generated-id-2' });

    expect(first).toBe('generated-id-1');
    expect(second).toBe('generated-id-1');
  });

  test('stores token only through the token vault boundary', async () => {
    const state = new MemoryStateStore();
    const tokenVault = new MemoryTokenVault();
    const credentials = createCredentialsAdapter({ state, tokenVault });

    await credentials.set({
      deviceId: 'device-1',
      token: 'sensitive-token',
      accountId: 'account-1',
    });

    const next = await credentials.get();
    expect(next).toEqual({
      deviceId: 'device-1',
      token: 'sensitive-token',
      accountId: 'account-1',
    });

    await credentials.clear();
    const cleared = await credentials.get();
    expect(cleared.token).toBeNull();
    expect(cleared.accountId).toBeNull();
    expect(cleared.deviceId).toBe('device-1');
  });

  test('uses fallback device name when empty name is set', async () => {
    const state = new MemoryStateStore();
    const tokenVault = new MemoryTokenVault();

    await setDeviceName({ state, tokenVault, deviceNameFactory: () => 'Fallback Device' }, '   ');
    const deviceName = await getDeviceName({ state, tokenVault, deviceNameFactory: () => 'Ignored' });

    expect(deviceName).toBe('Fallback Device');
  });
});
