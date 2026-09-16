/**
 * User settings, persisted in IndexedDB.
 *
 * Kept out of `localStorage` deliberately: the AI settings hold an API key, and
 * IndexedDB is the same origin-scoped store as the receipts themselves, so a
 * single "erase all data" action can reach everything. Settings are loaded once
 * at boot and cached in memory, so reads are synchronous everywhere else.
 */

import type { SecretName, SyncedSecret } from '@kvitto/shared';

import { APIVERKET_BASE_URL } from '../api/apiverket.js';
import { db } from '../db/db.js';
import { bus } from './events.js';

/** Where extraction requests are sent. */
export type AiProvider =
  /** Anthropic's API, called directly from the device with the user's key. */
  | 'anthropic'
  /** OpenAI's API, called directly from the device. */
  | 'openai'
  /** Any OpenAI-compatible endpoint: OpenRouter, Groq, LM Studio, vLLM. */
  | 'openai-compatible'
  /** A local Ollama instance. */
  | 'ollama'
  /** The companion server, which holds the provider keys instead of the device. */
  | 'server'
  /** No AI. Receipts are stored as images and filled in by hand. */
  | 'none';

export interface AiSettings {
  provider: AiProvider;
  model: string;
  /** Base URL for `openai-compatible` and `ollama`. */
  baseUrl: string;
  /** Stored locally and synchronized to the companion server when paired. */
  apiKey: string;
  maxOutputTokens: number;
  /**
   * Reasoning effort for providers that support it. `auto` omits the parameter,
   * which is the only safe default across models that reject it.
   */
  effort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Ask the provider to constrain its output to the receipt JSON schema.
   * Falls back to prompt-only JSON automatically if the provider rejects it.
   */
  structuredOutput: boolean;
  /** Run extraction automatically after a scan, instead of on a button press. */
  autoParse: boolean;
  /** Appended to the system prompt. For store-specific quirks. */
  extraInstructions: string;
}

export interface ImageSettings {
  detectEdges: boolean;
  /**
   * Let the scan screen take the picture by itself, once it can see a receipt
   * being held still. The shutter still works while it watches.
   */
  autoCapture: boolean;
  enhance: 'color' | 'grayscale' | 'binarize' | 'none';
  maxDimension: number;
  quality: number;
  /** Keep the untouched camera capture alongside the processed scan. */
  keepOriginal: boolean;
}

export interface SyncSettings {
  /** Companion server base URL, e.g. `https://kvitto.example.com`. */
  serverUrl: string;
  /** Sync automatically when online and after local changes. */
  autoSync: boolean;
  /** Upload receipt images too, not just the parsed data. */
  syncImages: boolean;
}

/**
 * Company lookup against Apiverket, keyed off the organisationsnummer that OCR
 * finds on the receipt. Separate from {@link AiSettings} because it is a plain
 * registry lookup rather than a model call, and it has its own key.
 */
export interface CompanySettings {
  /** Apiverket key (`sk_test_…` / `sk_live_…`). Synchronized when paired. */
  apiKey: string;
  baseUrl: string;
  /** Look the company up automatically after a scan finds an org number. */
  autoLookup: boolean;
  /**
   * Fall back to searching the registry by the shop's name when no
   * organisation number could be read.
   */
  nameSearch: boolean;
  /**
   * Name searches allowed per day. Apiverket meters this endpoint separately
   * and far more tightly than the rest of the API — twenty a day on a free key
   * — so the app keeps its own budget well inside that.
   */
  searchBudget: number;
}

/**
 * Name searches allowed per day, by default.
 *
 * Apiverket's search endpoint has its own daily quota — twenty calls on a free
 * key — shared with everything else the user does with that key. Budgeting
 * locally means a pile of unreadable receipts scanned in one sitting cannot
 * exhaust it, and the name cache means the budget is only ever spent on a shop
 * this device has never seen before.
 */
export const DEFAULT_SEARCH_BUDGET = 8;

export interface UiSettings {
  theme:
    | 'system'
    | 'light'
    | 'dark'
    | 'rabarber'
    | 'lingon'
    | 'pantgron'
    | 'blabar'
    | 'hjortron'
    | 'svartvinbar'
    | 'krusbar';
  /** Show discount and pant rows in the purchases list. */
  showAuxiliaryLines: boolean;
}

export interface AppSettings {
  ai: AiSettings;
  image: ImageSettings;
  company: CompanySettings;
  sync: SyncSettings;
  ui: UiSettings;
}


export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: 'none',
    model: 'claude-opus-5',
    baseUrl: '',
    apiKey: '',
    maxOutputTokens: 16000,
    effort: 'auto',
    structuredOutput: true,
    autoParse: true,
    extraInstructions: '',
  },
  image: {
    detectEdges: true,
    autoCapture: true,
    enhance: 'grayscale',
    maxDimension: 1568,
    quality: 0.9,
    keepOriginal: false,
  },
  company: {
    apiKey: '',
    baseUrl: APIVERKET_BASE_URL,
    autoLookup: true,
    nameSearch: true,
    searchBudget: DEFAULT_SEARCH_BUDGET,
  },
  sync: {
    serverUrl: '',
    autoSync: true,
    syncImages: true,
  },
  ui: {
    theme: 'rabarber',
    showAuxiliaryLines: false,
  },
};

const SETTINGS_KEY = 'settings';

let cached: AppSettings = structuredClone(DEFAULT_SETTINGS);
let loaded = false;

/** Loads settings from IndexedDB. Call once during boot. */
export async function loadSettings(): Promise<AppSettings> {
  const stored = await db.kv.get(SETTINGS_KEY);
  cached = merge(DEFAULT_SETTINGS, stored?.value);
  await loadSyncedSecrets();
  loaded = true;
  return cached;
}

/** The current settings. Returns defaults if called before {@link loadSettings}. */
export function getSettings(): AppSettings {
  if (!loaded) console.warn('getSettings() called before loadSettings(); using defaults.');
  return cached;
}

/** Merges a partial update into the stored settings and notifies listeners. */
export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  cached = merge(cached, patch);
  await db.kv.put({ key: SETTINGS_KEY, value: cached });
  await persistSecretPatches(patch);
  bus.emit('settings:changed', {});
  return cached;
}

/** Refreshes the synchronous settings cache after secret records arrive through sync. */
export async function refreshSyncedSecrets(): Promise<void> {
  const before = `${cached.ai.apiKey}\0${cached.company.apiKey}`;
  await loadSyncedSecrets(false);
  const after = `${cached.ai.apiKey}\0${cached.company.apiKey}`;
  if (before === after) return;
  await db.kv.put({ key: SETTINGS_KEY, value: cached });
  bus.emit('settings:changed', {});
}

/**
 * Settings with secrets removed. Used anywhere settings might be logged,
 * exported or displayed — the API key must never leave the device by accident.
 */
export function redactSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    ai: { ...settings.ai, apiKey: settings.ai.apiKey ? '••••••••' : '' },
    company: { ...settings.company, apiKey: settings.company.apiKey ? '••••••••' : '' },
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Recursively merges stored settings over the defaults.
 *
 * Going through the defaults means a settings object written by an older
 * version of the app gains any new keys instead of leaving them `undefined`,
 * and a corrupted value for one key cannot take the rest of the app down.
 */
function merge(base: AppSettings, patch: unknown): AppSettings {
  const result = structuredClone(base);
  if (!patch || typeof patch !== 'object') return result;

  for (const [section, values] of Object.entries(patch as Record<string, unknown>)) {
    if (!(section in result) || !values || typeof values !== 'object') continue;
    const target = result[section as keyof AppSettings] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (!(key in target) || value === undefined) continue;
      // Reject a stored value whose type drifted from the default's.
      if (typeof value !== typeof target[key]) continue;
      target[key] = value;
    }
  }
  return result;
}

const SECRET_PATHS: Record<SecretName, ['ai' | 'company', 'apiKey']> = {
  aiApiKey: ['ai', 'apiKey'],
  companyApiKey: ['company', 'apiKey'],
};

async function loadSyncedSecrets(migrate = true): Promise<void> {
  for (const [id, [section, key]] of Object.entries(SECRET_PATHS) as [SecretName, ['ai' | 'company', 'apiKey']][]) {
    const secret = await db.secrets.get(id);
    if (secret) {
      cached[section][key] = secret.deletedAt === 0 ? secret.value : '';
      continue;
    }

    const existing = cached[section][key];
    if (migrate && existing) await putSyncedSecret(id, existing);
  }
}

async function persistSecretPatches(patch: DeepPartial<AppSettings>): Promise<void> {
  if (patch.ai && Object.prototype.hasOwnProperty.call(patch.ai, 'apiKey')) {
    await putSyncedSecret('aiApiKey', cached.ai.apiKey);
  }
  if (patch.company && Object.prototype.hasOwnProperty.call(patch.company, 'apiKey')) {
    await putSyncedSecret('companyApiKey', cached.company.apiKey);
  }
}

async function putSyncedSecret(id: SecretName, value: string): Promise<void> {
  const existing = await db.secrets.get(id);
  const record: SyncedSecret = {
    id,
    value,
    updatedAt: Date.now(),
    deletedAt: 0,
    rev: existing?.rev ?? 0,
    dirty: 1,
  };
  await db.secrets.put(record);
  bus.emit('data:changed', { kinds: ['secrets'] });
}

/** True when the current configuration can actually run an extraction. */
export function isAiConfigured(settings: AppSettings = getSettings()): boolean {
  const { ai, sync } = settings;
  switch (ai.provider) {
    case 'none':
      return false;
    case 'server':
      return sync.serverUrl.trim().length > 0;
    case 'ollama':
      return ai.baseUrl.trim().length > 0 && ai.model.trim().length > 0;
    case 'anthropic':
    case 'openai':
    case 'openai-compatible':
      return ai.apiKey.trim().length > 0 && ai.model.trim().length > 0;
  }
}
