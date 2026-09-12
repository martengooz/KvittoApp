/**
 * Configuration, read once from the environment.
 *
 * Everything has a working default except the secrets, so `npm start` in a
 * fresh checkout brings up a usable single-user server with no setup.
 */

import { resolve } from 'node:path';

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer, got "${raw}".`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const dataDir = resolve(str('KVITTO_DATA_DIR', './data'));

export const config = {
  host: str('HOST', '0.0.0.0'),
  port: int('PORT', 8787),
  logLevel: str('LOG_LEVEL', 'info'),

  dataDir,
  databasePath: resolve(dataDir, str('KVITTO_DB_FILE', 'kvitto.sqlite')),
  blobDir: resolve(dataDir, 'blobs'),

  /**
   * Allowed browser origins. Empty means "reflect any origin", which is only
   * sensible behind a VPN — the startup banner warns when it is left empty.
   */
  corsOrigins: list('KVITTO_CORS_ORIGINS'),

  /** Largest single image accepted, in bytes. */
  maxBlobBytes: int('KVITTO_MAX_BLOB_BYTES', 12 * 1024 * 1024),
  /** Largest sync payload accepted, in bytes. */
  maxBodyBytes: int('KVITTO_MAX_BODY_BYTES', 24 * 1024 * 1024),
  /** Records returned per pull page. */
  pullPageSize: int('KVITTO_PULL_PAGE_SIZE', 500),

  /** Minutes a pairing code stays valid. */
  pairingCodeTtlMinutes: int('KVITTO_PAIRING_TTL_MINUTES', 15),

  ai: {
    /** `anthropic`, `openai`, or empty to disable the proxy. */
    provider: str('KVITTO_AI_PROVIDER', '').toLowerCase(),
    apiKey: str('KVITTO_AI_API_KEY', ''),
    model: str('KVITTO_AI_MODEL', 'claude-opus-5'),
    baseUrl: str('KVITTO_AI_BASE_URL', ''),
    maxOutputTokens: int('KVITTO_AI_MAX_TOKENS', 16000),
    /**
     * Models a device is allowed to request. Empty means only the configured
     * default — a device should not be able to bill the operator for anything
     * it likes just by naming a different model.
     */
    allowedModels: list('KVITTO_AI_ALLOWED_MODELS'),
  },

  /** Serve the built PWA from this directory, when set. */
  staticDir: process.env['KVITTO_STATIC_DIR'] ? resolve(process.env['KVITTO_STATIC_DIR']) : null,

  trustProxy: bool('KVITTO_TRUST_PROXY', false),
} as const;

export function aiProxyEnabled(): boolean {
  return config.ai.provider !== '' && config.ai.apiKey !== '';
}

/** Model ids the proxy will accept from a device. */
export function allowedModels(): string[] {
  if (!aiProxyEnabled()) return [];
  return config.ai.allowedModels.length > 0 ? config.ai.allowedModels : [config.ai.model];
}
