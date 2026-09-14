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
  /** Public origin encoded in pairing QR codes. Auto-detected on a local development host when omitted. */
  publicUrl: str('KVITTO_PUBLIC_URL', ''),

  dataDir,
  databasePath: resolve(dataDir, str('KVITTO_DB_FILE', 'kvitto.sqlite')),
  blobDir: resolve(dataDir, 'blobs'),
  /** Optional stable encryption secret; otherwise a key is generated under the data directory. */
  secretsKey: str('KVITTO_SECRETS_KEY', ''),

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

  /**
   * The optional local model.
   *
   * Off by default: it is a 3 GB download and a CPU-hungry background job, and
   * a sync relay must stay something you can run on a Raspberry Pi without
   * discovering it has started doing inference.
   */
  llm: {
    enabled: bool('KVITTO_LLM_ENABLED', false),
    baseUrl: str('KVITTO_LLM_BASE_URL', 'http://127.0.0.1:11434'),
    /**
     * Qwen3-VL 4B: the smallest vision model that reliably holds a JSON schema
     * over a receipt-sized image, and it fits in about 4 GB of RAM.
     */
    model: str('KVITTO_LLM_MODEL', 'qwen3-vl:4b'),
    /** Start `ollama serve` as a child process when nothing is listening. */
    manageProcess: bool('KVITTO_LLM_MANAGE_PROCESS', true),
    /** Explicit path to the binary, when it is somewhere unusual. */
    binary: str('KVITTO_LLM_BINARY', ''),
    /** Download the model on first use instead of waiting to be told. */
    autoPull: bool('KVITTO_LLM_AUTO_PULL', false),
    startupTimeoutMs: int('KVITTO_LLM_STARTUP_TIMEOUT_MS', 60_000),
    /** Per-receipt deadline. Generous: 4B on CPU is slow but not useless. */
    requestTimeoutMs: int('KVITTO_LLM_TIMEOUT_MS', 300_000),
    maxOutputTokens: int('KVITTO_LLM_MAX_TOKENS', 4096),
    /** Context window. A receipt image plus the schema needs more than 2k. */
    contextTokens: int('KVITTO_LLM_CONTEXT', 8192),
    /** Receipts taken from the queue per pass. */
    batchSize: int('KVITTO_LLM_BATCH_SIZE', 4),
    /** How often the worker looks for new work, in seconds. */
    intervalSeconds: int('KVITTO_LLM_INTERVAL_SECONDS', 60),
    /** Attempts before a receipt is parked as failed. */
    maxAttempts: int('KVITTO_LLM_MAX_ATTEMPTS', 3),
    /** First retry delay; doubles each attempt. */
    retryBaseMs: int('KVITTO_LLM_RETRY_BASE_MS', 30_000),
    /** Ceiling for the backoff. */
    retryMaxMs: int('KVITTO_LLM_RETRY_MAX_MS', 30 * 60_000),
  },

  /** Serve the built PWA from this directory, when set. */
  staticDir: process.env['KVITTO_STATIC_DIR'] ? resolve(process.env['KVITTO_STATIC_DIR']) : null,

  trustProxy: bool('KVITTO_TRUST_PROXY', false),
} as const;

export function llmEnabled(): boolean {
  return config.llm.enabled;
}
