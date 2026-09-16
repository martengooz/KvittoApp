import type { IdentityStateStore } from './identity';

const SERVER_URL_KEY = 'sync.serverUrl';
const AUTO_SYNC_KEY = 'sync.autoSync';
const WIFI_ONLY_KEY = 'sync.wifiOnly';

export interface PersistedSyncConfig {
  serverUrl: string;
  autoSync: boolean;
  wifiOnly: boolean;
}

export interface SyncConfigStore {
  read(): Promise<PersistedSyncConfig>;
  write(patch: Partial<PersistedSyncConfig>): Promise<PersistedSyncConfig>;
}

export function createSyncConfigStore(input: {
  state: IdentityStateStore;
  defaults?: Partial<PersistedSyncConfig>;
}): SyncConfigStore {
  const defaults: PersistedSyncConfig = {
    serverUrl: input.defaults?.serverUrl ?? '',
    autoSync: input.defaults?.autoSync ?? true,
    wifiOnly: input.defaults?.wifiOnly ?? true,
  };

  return {
    async read(): Promise<PersistedSyncConfig> {
      const [serverUrlRaw, autoSyncRaw, wifiOnlyRaw] = await Promise.all([
        input.state.get(SERVER_URL_KEY),
        input.state.get(AUTO_SYNC_KEY),
        input.state.get(WIFI_ONLY_KEY),
      ]);

      return {
        serverUrl: (serverUrlRaw ?? defaults.serverUrl).trim(),
        autoSync: parseBoolean(autoSyncRaw, defaults.autoSync),
        wifiOnly: parseBoolean(wifiOnlyRaw, defaults.wifiOnly),
      };
    },

    async write(patch: Partial<PersistedSyncConfig>): Promise<PersistedSyncConfig> {
      const current = await this.read();
      const next: PersistedSyncConfig = {
        serverUrl: patch.serverUrl !== undefined ? patch.serverUrl.trim() : current.serverUrl,
        autoSync: patch.autoSync ?? current.autoSync,
        wifiOnly: patch.wifiOnly ?? current.wifiOnly,
      };

      await Promise.all([
        input.state.set(SERVER_URL_KEY, next.serverUrl),
        input.state.set(AUTO_SYNC_KEY, String(next.autoSync)),
        input.state.set(WIFI_ONLY_KEY, String(next.wifiOnly)),
      ]);

      return next;
    },
  };
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
